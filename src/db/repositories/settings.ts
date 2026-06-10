import { sql } from '../client.js';

/**
 * Репозиторий настроек (key-value, value хранится как JSONB).
 *
 * value возвращается уже распарсенным postgres.js (число/строка/boolean/объект).
 * Сериализация при записи — через sql.json, чтобы корректно положить JSONB.
 */

export async function getSetting(key: string): Promise<unknown> {
  const rows = await sql<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${key}
  `;
  const row = rows[0];
  return row === undefined ? undefined : row.value;
}

export async function setSetting(key: string, value: unknown, updatedBy?: string): Promise<void> {
  await sql`
    INSERT INTO settings (key, value, updated_by)
    VALUES (${key}, ${sql.json(value as never)}, ${updatedBy ?? null})
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by
  `;
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = await sql<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings
  `;
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
