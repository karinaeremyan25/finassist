import type { Context, NextFunction } from 'grammy';
import { getUserByTelegramId } from '../../db/repositories/users.js';
import { childLogger } from '../../utils/logger.js';
import type { AppUser } from '../../types.js';

/**
 * Auth middleware.
 *
 * - Первая проверка в каждом handler (через bot.use).
 * - Проверяет только наличие telegram_id в app_users (is_active = true).
 * - Заполняет ctx.user — доступен во всех последующих middleware и handlers.
 * - Только приватные чаты (group/supergroup → игнорируются).
 * - Незнакомый telegram_id → "⛔ Доступ запрещён..." без дальнейшей обработки.
 */

const log = childLogger({ handler: 'auth' });

export interface BotContext extends Context {
  user: AppUser;
}

export async function authMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  // Только приватные чаты
  if (ctx.chat?.type !== 'private') {
    return;
  }

  const telegramId = ctx.from?.id;
  if (telegramId === undefined) {
    return;
  }

  const start = Date.now();

  try {
    const user = await getUserByTelegramId(BigInt(telegramId));

    if (user === null || !user.isActive) {
      log.warn({ telegram_id: telegramId }, 'auth_access_denied');
      await ctx.reply(
        '⛔ Доступ запрещён.\nЭтот бот предназначен только для команды Карины Еремян.'
      );
      return;
    }

    ctx.user = user;

    log.info(
      {
        telegram_id: telegramId,
        user_id: user.id,
        role: user.role,
        latency_ms: Date.now() - start,
      },
      'auth_ok'
    );

    await next();
  } catch (err) {
    log.error({ err, telegram_id: telegramId, latency_ms: Date.now() - start }, 'auth_error');
    await ctx.reply('❌ Ошибка при проверке доступа. Попробуйте ещё раз через минуту.');
  }
}
