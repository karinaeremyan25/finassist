import postgres from 'postgres';
import { config } from '../config.js';

/**
 * Singleton-клиент PostgreSQL (postgres.js).
 *
 * Особенности конфигурации под FinAssist:
 * - BIGINT (PostgreSQL oid 20 / int8) парсится в JS `bigint`, а не в строку.
 *   Все денежные суммы хранятся в копейках как BIGINT, поэтому на уровне TS
 *   мы всегда работаем с `bigint` — без потери точности и без float.
 * - Пул соединений ограничен (Supabase pooler), таймауты заданы явно.
 *
 * RLS в БД отключена (см. CLAUDE.md): изоляция данных делается в Node.js-слое.
 */
export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
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
