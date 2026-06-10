#!/usr/bin/env node
/**
 * Раннер миграций FinAssist.
 *
 *   node scripts/migrate.mjs           — применить все непринятые миграции
 *   node scripts/migrate.mjs --status  — показать статус, ничего не применять
 *
 * Особенности:
 * - Трекинг применённых миграций в таблице schema_migrations.
 * - Безопасный baseline: если БД уже существует (есть app_users), но
 *   schema_migrations пуста — помечает 001–003 как уже применённые БЕЗ запуска
 *   (чтобы не падать на «таблица уже существует» на проде).
 * - Каждая миграция — в транзакции (DDL в Postgres транзакционен).
 * - DATABASE_URL берётся из окружения или из .env (загружается без зависимостей).
 * - Секреты (строка подключения) НИКОГДА не печатаются.
 */

import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_DIR = 'db/migrations';
const BASELINE = ['001_init.sql', '002_seed.sql', '003_seed_users.sql'];
const STATUS_ONLY = process.argv.includes('--status');

/** Загружает .env в process.env (только отсутствующие ключи), без зависимостей. */
async function loadDotEnv() {
  let raw;
  try {
    raw = await readFile('.env', 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

async function main() {
  await loadDotEnv();

  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    console.error('✖ DATABASE_URL не задан. Заполните его в .env и повторите: npm run migrate');
    process.exit(1);
  }

  const sql = postgres(url, { onnotice: () => {}, idle_timeout: 5, max: 1 });

  try {
    await sql`SELECT 1`; // ранняя проверка соединения
  } catch (err) {
    console.error('✖ Не удалось подключиться к БД. Проверьте DATABASE_URL и доступ (IP allowlist Supabase).');
    console.error('  Детали:', err.code ?? err.message);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const appliedRows = await sql`SELECT filename FROM schema_migrations`;
    const applied = new Set(appliedRows.map((r) => r.filename));

    // Baseline: БД уже существует, но трекер пуст → 001–003 считаем применёнными.
    if (applied.size === 0) {
      const existsRows = await sql`SELECT to_regclass('public.app_users') AS t`;
      if (existsRows[0]?.t) {
        if (STATUS_ONLY) {
          console.log('ℹ Существующая БД: 001–003 будут помечены baseline при первом запуске.');
        } else {
          console.log('ℹ Обнаружена существующая БД — помечаю 001–003 baseline (без выполнения).');
          for (const f of BASELINE) {
            await sql`INSERT INTO schema_migrations (filename) VALUES (${f}) ON CONFLICT DO NOTHING`;
            applied.add(f);
          }
        }
      }
    }

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    if (STATUS_ONLY) {
      console.log('\nСтатус миграций:');
      for (const f of files) {
        console.log(`  ${applied.has(f) ? '✓ применена ' : '· ожидает  '} ${f}`);
      }
      return;
    }

    let count = 0;
    for (const f of files) {
      if (applied.has(f)) {
        console.log(`  ✓ ${f} (уже применена)`);
        continue;
      }
      const text = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
      process.stdout.write(`  → применяю ${f} ... `);
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${f})`;
      });
      count++;
      console.log('ок');
    }
    console.log(count === 0 ? '\n✓ Все миграции уже применены.' : `\n✓ Применено новых миграций: ${count}.`);
  } catch (err) {
    console.error('\n✖ Ошибка применения миграций:', err.message ?? err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('✖ Непредвиденная ошибка:', err.message ?? err);
  process.exit(1);
});
