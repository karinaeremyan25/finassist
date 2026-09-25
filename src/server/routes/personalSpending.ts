/**
 * GET/POST /api/cron/personal-spending — сводка личных трат Карины (карта …7820)
 * за неделю / 2 недели / месяц, в личку Карине.
 *
 * ?debug=1 — вернуть отчёт JSON (текст + примеры) БЕЗ отправки (для настройки).
 * Авторизация как у /api/tochka/sync: Bearer CRON_SECRET или ?key=sha256(BOT_TOKEN).
 */
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { sendPersonalReport, buildPersonalReport } from '../../services/personalSpending.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'cron:personal-spending' });

export const personalSpendingCronHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const authHeader = req.rawReq.headers['authorization'];
  const cronSecret = config.CRON_SECRET;
  const syncKey = createHash('sha256').update(config.BOT_TOKEN).digest('hex');
  const isCron =
    (cronSecret !== undefined && cronSecret.length > 0 && authHeader === `Bearer ${cronSecret}`) ||
    req.query['key'] === syncKey;
  if (!isCron) {
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  try {
    if (req.query['debug'] === '1') {
      const r = await buildPersonalReport();
      return {
        status: 200,
        body: {
          ok: true,
          text: r.text,
          weekTotal: Number(r.week.total) / 100,
          twoWeeksTotal: Number(r.twoWeeks.total) / 100,
          monthTotal: Number(r.month.total) / 100,
          weekCount: r.week.count,
          monthCount: r.month.count,
          sampleOther: r.sampleDescriptions,
        },
      };
    }
    const result = await sendPersonalReport();
    log.info({ sent: result.sent }, 'personal_spending_ok');
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'personal_spending_error');
    return { status: 200, body: { ok: false, error: message } };
  }
};
