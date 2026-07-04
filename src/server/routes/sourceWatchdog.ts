/**
 * GET/POST /api/cron/source-watchdog — сторож молчания источников.
 *
 * Запускается кроном раз в сутки. Если источник дохода перестал слать данные
 * дольше порога — шлёт алерт владельцу и бухгалтерам в Telegram.
 *
 * Авторизация как у /api/tochka/sync:
 *   1. Заголовок `Authorization: Bearer <CRON_SECRET>` (если задан).
 *   2. Query-параметр ?key= = sha256(BOT_TOKEN).
 * Иначе — 401.
 */

import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { checkSilentSources } from '../../services/sourceWatchdog.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'cron:source-watchdog' });

export const sourceWatchdogHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  const authHeader = req.rawReq.headers['authorization'];
  const cronSecret = config.CRON_SECRET;
  const syncKey = createHash('sha256').update(config.BOT_TOKEN).digest('hex');
  const isCronRequest =
    (cronSecret !== undefined &&
      cronSecret.length > 0 &&
      typeof authHeader === 'string' &&
      authHeader === `Bearer ${cronSecret}`) ||
    req.query['key'] === syncKey;

  if (!isCronRequest) {
    log.warn({ handler: 'source_watchdog' }, 'source_watchdog_auth_denied');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  try {
    const result = await checkSilentSources();
    log.info(
      {
        handler: 'source_watchdog',
        latency_ms: Date.now() - start,
        checked: result.checked,
        alerted: result.alerted.length,
        throttled: result.skippedThrottled.length,
      },
      'source_watchdog_ok'
    );
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ handler: 'source_watchdog', error: message }, 'source_watchdog_error');
    return { status: 200, body: { ok: false, error: message } };
  }
};
