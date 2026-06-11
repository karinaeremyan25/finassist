import { sql } from '../client.js';

/**
 * Репозиторий настроек (key-value).
 *
 * Реальная схема: settings.value = TEXT (не JSONB), updated_by = BIGINT.
 * В settings хранятся текстовые значения (токены, строки конфига).
 * Для токенов Точки: key='tochka_refresh_token', value=<строка токена>.
 */

export async function getSetting(key: string): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM settings WHERE key = ${key} LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : row.value;
}

export async function setSetting(
  key: string,
  value: string,
  updatedBy?: bigint
): Promise<void> {
  await sql`
    INSERT INTO settings (key, value, updated_by)
    VALUES (${key}, ${value}, ${updatedBy ?? null})
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await sql<{ key: string; value: string }[]>`
    SELECT key, value FROM settings
  `;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
