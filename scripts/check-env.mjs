#!/usr/bin/env node
/**
 * Preflight-проверка окружения FinAssist.
 *
 *   npm run preflight
 *
 * Показывает, какие переменные .env заполнены, а какие — нет, и где их взять.
 * НИКОГДА не печатает значения секретов (только ✓/✗ и подсказку).
 * Выход 0 — все ОБЯЗАТЕЛЬНЫЕ заполнены; иначе 1.
 */

import { readFile } from 'node:fs/promises';

async function loadDotEnv() {
  let raw;
  try {
    raw = await readFile('.env', 'utf8');
  } catch {
    console.log('⚠ Файл .env не найден. Скопируйте .env.example → .env и заполните.\n');
    return;
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

/** group: {title, vars:[{name, required, hint}]} */
const GROUPS = [
  {
    title: 'Ядро (обязательно — без этого бот не запустится)',
    vars: [
      { name: 'BOT_TOKEN', required: true, hint: '@BotFather → /newbot или /token' },
      { name: 'DATABASE_URL', required: true, hint: 'Supabase → Project Settings → Database → Connection string (URI)' },
      { name: 'ANTHROPIC_API_KEY', required: true, hint: 'console.anthropic.com → API Keys' },
      { name: 'OWNER_TG_ID', required: true, hint: 'ваш telegram_id (@userinfobot)' },
      { name: 'ACCOUNTANT_TG_ID', required: true, hint: 'telegram_id бухгалтера (@userinfobot)' },
    ],
  },
  {
    title: 'Mini App (нужно для кнопки и web_app)',
    vars: [
      { name: 'WEBAPP_URL', required: false, hint: 'https://<ваш-домен> — публичный HTTPS-адрес Mini App' },
      { name: 'MANAGER_TG_ID', required: false, hint: 'CSV telegram_id менеджеров (можно пусто)' },
      { name: 'WEBAPP_PORT', required: false, hint: 'порт HTTP-сервера, по умолчанию 8080' },
      { name: 'WEBAPP_STATIC_DIR', required: false, hint: 'путь к dist (на проде /var/www/finassist-webapp)' },
    ],
  },
  {
    title: 'Платёжные источники (заполните ТОЛЬКО используемые)',
    vars: [
      { name: 'ROBOKASSA_MERCHANT_LOGIN', required: false, hint: 'Robokassa → Мои магазины → идентификатор' },
      { name: 'ROBOKASSA_PASSWORD', required: false, hint: 'Robokassa → Технические настройки → Пароль #2' },
      { name: 'PRODAMUS_SECRET_KEY', required: false, hint: 'Prodamus → Настройки → секретный ключ (для webhook-подписи)' },
      { name: 'PRODAMUS_API_KEY', required: false, hint: 'Prodamus → Настройки → API (опционально)' },
      { name: 'TOCHKA_CLIENT_ID', required: false, hint: 'Точка → Интеграции и API → OAuth-приложение' },
      { name: 'TOCHKA_CLIENT_SECRET', required: false, hint: 'Точка → Интеграции и API → OAuth-приложение' },
    ],
  },
  {
    title: 'Прочее (опционально)',
    vars: [
      { name: 'AI_MENTOR_MODEL', required: false, hint: 'по умолчанию claude-opus-4-8' },
      { name: 'CLAUDE_MODEL', required: false, hint: 'по умолчанию claude-sonnet-4-6' },
      { name: 'DEEPGRAM_API_KEY', required: false, hint: 'голосовой ввод (опционально)' },
      { name: 'HEALTHCHECKS_URL', required: false, hint: 'мониторинг простоев (опционально)' },
    ],
  },
];

function isSet(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

async function main() {
  await loadDotEnv();

  console.log('\n══════ FinAssist · проверка .env ══════\n');
  let missingRequired = 0;

  for (const group of GROUPS) {
    console.log(group.title);
    for (const v of group.vars) {
      const set = isSet(v.name);
      const mark = set ? '✓' : (v.required ? '✗' : '·');
      const status = set ? 'задано' : (v.required ? 'НЕ ЗАДАНО (обязательно)' : 'не задано');
      const hint = set ? '' : `  ← ${v.hint}`;
      console.log(`  ${mark} ${v.name.padEnd(26)} ${status}${hint}`);
      if (!set && v.required) missingRequired++;
    }
    console.log('');
  }

  // Подсказки по связности
  const tochkaPartial = isSet('TOCHKA_CLIENT_ID') !== isSet('TOCHKA_CLIENT_SECRET');
  const robokassaPartial = isSet('ROBOKASSA_MERCHANT_LOGIN') !== isSet('ROBOKASSA_PASSWORD');
  if (tochkaPartial) console.log('⚠ Точка: нужны ОБА — TOCHKA_CLIENT_ID и TOCHKA_CLIENT_SECRET.');
  if (robokassaPartial) console.log('⚠ Robokassa: нужны ОБА — ROBOKASSA_MERCHANT_LOGIN и ROBOKASSA_PASSWORD.');
  if (isSet('WEBAPP_URL') && !process.env['WEBAPP_URL'].startsWith('https://'))
    console.log('⚠ WEBAPP_URL должен начинаться с https:// (требование Telegram web_app).');

  console.log('───────────────────────────────────────');
  if (missingRequired === 0) {
    console.log('✓ Обязательные переменные заполнены. Можно запускать: npm run migrate, затем деплой.');
    process.exit(0);
  } else {
    console.log(`✗ Не заполнено обязательных переменных: ${missingRequired}. Заполните их в .env и повторите.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Ошибка preflight:', err.message ?? err);
  process.exit(1);
});
