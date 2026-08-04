/**
 * POST /api/telegram/webhook — приём входящих Telegram-апдейтов.
 *
 * Аутентификация: Telegram присылает заголовок X-Telegram-Bot-Api-Secret-Token,
 * равный секрету, заданному при setWebhook. Секрет детерминирован от BOT_TOKEN
 * (sha256), поэтому и скрипт установки, и роут считают одно и то же — без
 * доп. переменных окружения.
 *
 * Всегда отвечаем 200 (даже при внутренней ошибке), чтобы Telegram не ретраил.
 */
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { handleTelegramUpdate } from '../../services/telegram/updateHandler.js';
import type { TgUpdate } from '../../services/telegram/updateHandler.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'tg-webhook' });

/** Секрет для заголовка X-Telegram-Bot-Api-Secret-Token (A-Z a-z 0-9 _ -). */
export function webhookSecret(): string {
  return createHash('sha256').update(`${config.BOT_TOKEN}:tg-webhook`).digest('hex');
}

export const telegramWebhookHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const got = req.rawReq.headers['x-telegram-bot-api-secret-token'];
  const expected = webhookSecret();
  if (typeof got !== 'string' || got !== expected) {
    log.warn({}, 'tg_webhook_bad_secret');
    return { status: 401, body: { ok: false } };
  }

  try {
    const update = req.body as TgUpdate | undefined;
    if (update !== undefined && update !== null) {
      await handleTelegramUpdate(update);
    }
  } catch (err) {
    log.error({ err: String(err) }, 'tg_webhook_error');
  }
  // Telegram нужен быстрый 200 — иначе ретраи.
  return { status: 200, body: { ok: true } };
};
