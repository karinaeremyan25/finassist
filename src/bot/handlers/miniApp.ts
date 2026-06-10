import { InlineKeyboard } from 'grammy';
import { config } from '../../config.js';
import type { BotContextWithSession } from '../middleware/session.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'miniApp' });

/**
 * Хендлер команды /app.
 *
 * Открывает Mini App через web_app inline-кнопку.
 * Если WEBAPP_URL не задан — выводит предупреждение и пишет warn в лог.
 * Работает только в приватных чатах (auth middleware уже обеспечивает это).
 */
export async function handleMiniApp(ctx: BotContextWithSession): Promise<void> {
  const telegramId = ctx.from?.id;
  const start = Date.now();

  try {
    if (config.WEBAPP_URL === undefined) {
      log.warn(
        { telegram_id: telegramId, handler: 'miniApp', latency_ms: Date.now() - start },
        'miniapp_unavailable_no_url'
      );
      await ctx.reply(
        '⚠️ Mini App временно недоступен.\n' +
          'Обратитесь к администратору или попробуйте позже.'
      );
      return;
    }

    const keyboard = new InlineKeyboard().webApp(
      '📊 Открыть аналитику',
      config.WEBAPP_URL
    );

    await ctx.reply('Откройте аналитический дашборд FinAssist:', {
      reply_markup: keyboard,
    });

    log.info(
      { telegram_id: telegramId, handler: 'miniApp', latency_ms: Date.now() - start },
      'miniapp_button_sent'
    );
  } catch (err) {
    log.error(
      { err, telegram_id: telegramId, handler: 'miniApp', latency_ms: Date.now() - start },
      'miniapp_error'
    );
    throw err;
  }
}
