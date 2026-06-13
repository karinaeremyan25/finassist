import postgres from 'postgres';
import { config } from '../config.js';

/**
 * Singleton-клиент PostgreSQL (postgres.js).
 *
 * Особенности конфигурации под FinAssist:
 * - BIGINT (PostgreSQL oid 20 / int8) парсится в JS `bigint`, а не в строку.
 *   Все денежные суммы хранятся в копейках как BIGINT, поэтому на уровне TS
 *   мы всегда работаем с `bigint` — без потери точности и без float.
 *
 * Два режима работы (определяются по окружению):
 * - VPS (long polling бот): direct-подключение Supabase (порт 5432), полноценный
 *   пул (max 10). Долгоживущий процесс, держать пул выгодно.
 * - Vercel serverless (Mini App API): pooled-строка Supabase (порт 6543,
 *   transaction mode pgBouncer). В serverless нельзя держать пул между
 *   инвокациями, а pgBouncer в transaction mode НЕ поддерживает prepared
 *   statements — поэтому max: 1, prepare: false, idle_timeout: 20.
 *   Признак среды — переменная VERCEL, которую платформа задаёт автоматически.
 *
 * DATABASE_URL на Vercel ОБЯЗАТЕЛЬНО должен быть pooled-строкой (порт 6543).
 *
 * RLS в БД отключена (см. CLAUDE.md): изоляция данных делается в Node.js-слое.
 */
const isServerless = process.env['VERCEL'] === '1';

export const sql = postgres(config.DATABASE_URL, {
  // В serverless теперь ВСЕ /api/* идут через одну функцию (router), и дашборд
  // шлёт несколько запросов параллельно. С max:1 они сериализовались на одном
  // соединении и тяжёлый запрос (инсайты) блокировал остальные карточки → «висели».
  // max:5 даёт одной инвокации обрабатывать параллельные запросы; pgBouncer пулит.
  max: isServerless ? 5 : 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // pgBouncer (transaction mode, порт 6543) несовместим с prepared statements.
  // На VPS (direct 5432) prepare остаётся включённым — это быстрее.
  prepare: !isServerless,
  types: {
    // Парсинг int8 (BIGINT, oid 20) → JS bigint.
    // serialize нужен, чтобы передавать bigint-параметры обратно в БД.
    bigint: {
      to: 20,
      from: [20],
      serialize: (value: bigint): string => value.toString(),
      parse: (value: string): bigint => BigInt(value),
    },
  },
});

/**
 * Корректно закрывает пул соединений.
 * Вызывать при graceful shutdown бота (SIGINT / SIGTERM).
 */
export async function disconnect(): Promise<void> {
  await sql.end({ timeout: 5 });
}
