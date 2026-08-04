/**
 * GET/POST /api/cron/daily-report — ежедневный отчёт в «Фин.отдел ПСИЗ».
 *
 * Отправляет отчёт (доход/расход план-факт + остатки фондов) в группу.
 * Основной запуск — попутно из tochkaSync 2×/день (10:00 и 21:00 МСК).
 * Этот роут — для ручного запуска/теста и как резервный триггер внешним кроном.
 *
 * Авторизация как у /api/tochka/sync:
 *   1. Заголовок `Authorization: Bearer <CRON_SECRET>` (если задан).
 *   2. Query-параметр ?key= = sha256(BOT_TOKEN).
 * Иначе — 401.
 */

import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { sendDailyReport } from '../../services/dailyReport.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'cron:daily-report' });

export const dailyReportHandler: ApiHandler = async (req): Promise<ApiResponse> => {
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
    log.warn({ handler: 'daily_report' }, 'daily_report_auth_denied');
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  try {
    const result = await sendDailyReport();
    log.info(
      { handler: 'daily_report', latency_ms: Date.now() - start, sent: result.sent },
      'daily_report_ok'
    );
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ handler: 'daily_report', error: message }, 'daily_report_error');
    return { status: 200, body: { ok: false, error: message } };
  }
};
