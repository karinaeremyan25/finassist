import { sql } from '../client.js';
import { mapBotSession, type BotSessionRow } from './_mappers.js';
import type { BotSession } from '../../types.js';

/**
 * Репозиторий FSM-сессий бота (grammY).
 *
 * Сессии в БД, а не в памяти: бот перезапускается PM2, состояние диалогов
 * должно переживать рестарт. expires_at — TTL, истёкшие чистит cron.
 */

const SESSION_TTL = sql`NOW() + INTERVAL '1 hour'`;

export async function getSession(telegramId: bigint): Promise<BotSession | null> {
  const rows = await sql<BotSessionRow[]>`
    SELECT telegram_id, state, context, expires_at
    FROM bot_sessions
    WHERE telegram_id = ${telegramId} AND expires_at > NOW()
  `;
  const row = rows[0];
  return row === undefined ? null : mapBotSession(row);
}

export async function setSession(
  telegramId: bigint,
  state: string,
  context: Record<string, unknown>
): Promise<void> {
  await sql`
    INSERT INTO bot_sessions (telegram_id, state, context, expires_at)
    VALUES (${telegramId}, ${state}, ${sql.json(context as never)}, ${SESSION_TTL})
    ON CONFLICT (telegram_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      context = EXCLUDED.context,
      expires_at = ${SESSION_TTL}
  `;
}

export async function clearSession(telegramId: bigint): Promise<void> {
  await sql`
    DELETE FROM bot_sessions WHERE telegram_id = ${telegramId}
  `;
}

/** Удаляет истёкшие сессии. Возвращает число удалённых строк. */
export async function clearExpiredSessions(): Promise<number> {
  const result = await sql`
    DELETE FROM bot_sessions WHERE expires_at <= NOW()
  `;
  return result.count;
}
