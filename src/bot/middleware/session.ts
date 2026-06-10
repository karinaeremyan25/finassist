import type { NextFunction } from 'grammy';
import {
  getSession as repoGetSession,
  setSession as repoSetSession,
  clearSession as repoClearSession,
} from '../../db/repositories/sessions.js';
import { childLogger } from '../../utils/logger.js';
import type { BotContext } from './auth.js';
import type { BotSession } from '../../types.js';

/**
 * Session middleware — FSM-сессии в БД (не в памяти).
 *
 * Бот может перезапуститься PM2, поэтому session хранится в bot_sessions.
 * Каждый ctx после authMiddleware получает ctx.session с методами get/set/clear.
 */

const log = childLogger({ handler: 'session' });

export interface SessionData {
  state: string;
  context: Record<string, unknown>;
}

export interface BotContextWithSession extends BotContext {
  session: {
    get(): Promise<BotSession | null>;
    set(state: string, context: Record<string, unknown>): Promise<void>;
    clear(): Promise<void>;
  };
}

/** Читает сессию из БД. */
export async function getSession(telegramId: bigint): Promise<BotSession | null> {
  return repoGetSession(telegramId);
}

/** Сохраняет/обновляет сессию в БД. */
export async function setSession(
  telegramId: bigint,
  state: string,
  context: Record<string, unknown>
): Promise<void> {
  await repoSetSession(telegramId, state, context);
}

/** Удаляет сессию. */
export async function clearSession(telegramId: bigint): Promise<void> {
  await repoClearSession(telegramId);
}

/**
 * grammY-middleware: навешивает ctx.session с методами get/set/clear.
 * Поскольку сессия в БД, все методы — async.
 */
export function sessionMiddleware() {
  return async (ctx: BotContextWithSession, next: NextFunction): Promise<void> => {
    const telegramId = BigInt(ctx.from?.id ?? 0);

    ctx.session = {
      get: () => {
        return getSession(telegramId).catch((err) => {
          log.error({ err, telegram_id: telegramId.toString() }, 'session_get_error');
          return null;
        });
      },
      set: async (state: string, context: Record<string, unknown>) => {
        try {
          await setSession(telegramId, state, context);
        } catch (err) {
          log.error({ err, telegram_id: telegramId.toString(), state }, 'session_set_error');
        }
      },
      clear: async () => {
        try {
          await clearSession(telegramId);
        } catch (err) {
          log.error({ err, telegram_id: telegramId.toString() }, 'session_clear_error');
        }
      },
    };

    await next();
  };
}
