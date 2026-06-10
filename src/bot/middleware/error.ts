import type { BotError } from 'grammy';
import { sql } from '../../db/client.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { childLogger } from '../../utils/logger.js';
import type { BotContext } from './auth.js';

/**
 * Глобальный error handler grammY (bot.catch).
 *
 * - Логирует полный stack trace через pino.
 * - Отправляет пользователю дежурное сообщение об ошибке.
 * - Отправляет owner алерт о критических ошибках (throttle: 1 раз в 10 минут).
 * - Не логирует текст сообщений пользователя.
 */

const log = childLogger({ handler: 'error' });

const OWNER_ALERT_THROTTLE_MS = 10 * 60 * 1000; // 10 минут
let lastOwnerAlertTs = 0;

export async function errorHandler(err: BotError<BotContext>): Promise<void> {
  const ctx = err.ctx;
  const telegramId = ctx.from?.id;
  const updateType = Object.keys(ctx.update ?? {})[0] ?? 'unknown';
  const handler = (ctx.match as string | undefined) ?? updateType;

  log.error(
    {
      err: err.error,
      telegram_id: telegramId,
      handler,
      update_type: updateType,
    },
    'bot_error'
  );

  // Ответить пользователю
  try {
    await ctx.reply(
      '❌ Что-то пошло не так. Я записала ошибку, попробуйте ещё раз через минуту.'
    );
  } catch (replyErr) {
    log.error({ err: replyErr, telegram_id: telegramId }, 'bot_error_reply_failed');
  }

  // Алерт owner (throttle)
  const now = Date.now();
  if (now - lastOwnerAlertTs < OWNER_ALERT_THROTTLE_MS) {
    return;
  }

  try {
    const users = await getAllActiveUsers();
    const owners = users.filter((u) => u.role === 'owner');

    const errorMessage =
      err.error instanceof Error ? err.error.message : String(err.error);

    const alertText = [
      `⚠️ *Ошибка бота*`,
      ``,
      `Handler: \`${handler}\``,
      `Ошибка: ${errorMessage.slice(0, 300)}`,
    ].join('\n');

    for (const owner of owners) {
      try {
        // Используем raw API без ctx, т.к. ctx может быть сломан
        await ctx.api.sendMessage(Number(owner.telegramId), alertText, {
          parse_mode: 'Markdown',
        });
      } catch (sendErr) {
        log.error({ err: sendErr, owner_id: owner.id }, 'bot_error_owner_alert_failed');
      }
    }

    // Лог в alert_log
    try {
      const ownerUser = owners[0];
      if (ownerUser !== undefined) {
        await sql`
          INSERT INTO alert_log (alert_type, recipient_user_id, payload, delivery_status)
          VALUES ('tax_warning', ${ownerUser.id}, ${sql.json({ handler, error: errorMessage } as never)}, 'sent')
        `;
      }
    } catch {
      // Не критично
    }

    lastOwnerAlertTs = now;
  } catch (alertErr) {
    log.error({ err: alertErr }, 'bot_error_owner_alert_outer_failed');
  }
}
