/**
 * POST /api/tochka/sync — ручной или cron-запуск синхронизации Точки.
 *
 * Авторизация двумя способами:
 *   1. Cron: заголовок `Authorization: Bearer <CRON_SECRET>`
 *      (CRON_SECRET задан в config, иначе cron-путь недоступен).
 *   2. Пользователь Mini App: заголовок `X-Telegram-Init-Data` или
 *      поле `initData` в теле — верифицируется через resolveWebAppUser.
 *      При ошибке авторизации → 401.
 *
 * При успешной авторизации вызывает syncTochka() и возвращает
 *   { ok: true, added, balancesUpdated, classified, dateTo }.
 * При ошибке синхронизации (в т.ч. нет TOCHKA_JWT_TOKEN) →
 *   HTTP 200, { ok: false, error: '...' } (чтобы фронт показал сообщение,
 *   а не «упал» на 5xx). Ошибка логируется.
 */

import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { syncTochka } from '../../services/integrations/tochkaSync.js';
import { checkSilentSources } from '../../services/sourceWatchdog.js';
import { notifyFotDistribution } from '../../services/fotNotify.js';
import { sendDailyReport } from '../../services/dailyReport.js';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'tochka:sync' });

export const tochkaSyncHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  // ── Авторизация ──────────────────────────────────────────────────────────

  const authHeader = req.rawReq.headers['authorization'];
  const cronSecret = config.CRON_SECRET;

  // Cron-авторизация двумя способами:
  //  1) Заголовок Bearer = CRON_SECRET (если задан и без пробелов).
  //  2) Query-параметр ?key= = sha256(BOT_TOKEN) — используется GitHub Actions
  //     cron (см. .github/workflows/tochka-sync.yml). Хэш безопасно публичен:
  //     по нему нельзя восстановить токен, а сервер проверяет, пересчитывая хэш.
  const syncKey = createHash('sha256').update(config.BOT_TOKEN).digest('hex');
  const isCronRequest =
    (cronSecret !== undefined &&
      cronSecret.length > 0 &&
      typeof authHeader === 'string' &&
      authHeader === `Bearer ${cronSecret}`) ||
    req.query['key'] === syncKey;

  if (!isCronRequest) {
    // Пользовательская авторизация через Telegram Mini App initData
    try {
      await resolveWebAppUser(req);
    } catch (err) {
      const reason = err instanceof WebAppAuthError ? err.reason : 'unknown';
      log.warn(
        { handler: 'tochka_sync', latency_ms: Date.now() - start, reason },
        'tochka_sync_auth_denied'
      );
      return unauthorizedResponse();
    }
  } else {
    log.info(
      { handler: 'tochka_sync', latency_ms: 0 },
      'tochka_sync_cron_authorized'
    );
  }

  // ── Синхронизация ────────────────────────────────────────────────────────

  // РАЗВЯЗКА: синк и попутные задачи (отчёт/алерты/ФОТ) НЕЗАВИСИМЫ. Если синк
  // Точки падает (напр. «fetch failed» / протух токен) — отчёт всё равно уходит.
  // Отчёт читает данные из БД, ему не нужна живая Точка. Так «отчёт не пришёл»
  // из-за проблем с Точкой больше не случится.

  let result: Awaited<ReturnType<typeof syncTochka>> | null = null;
  let syncError: string | null = null;
  try {
    result = await syncTochka();
  } catch (err) {
    syncError = err instanceof Error ? err.message : String(err);
    log.error(
      { handler: 'tochka_sync', latency_ms: Date.now() - start, error: syncError },
      'tochka_sync_error'
    );
  }

  // Попутные задачи только для крон-запусков. Каждая в своём try/catch и НЕ
  // зависит от успеха синка — выполняются даже если syncTochka() упал.
  if (isCronRequest) {
    try {
      const wd = await checkSilentSources();
      log.info(
        { handler: 'tochka_sync', watchdog_alerted: wd.alerted, watchdog_silent: wd.silent },
        'source_watchdog_piggyback'
      );
    } catch (wdErr) {
      log.error({ handler: 'tochka_sync', error: String(wdErr) }, 'source_watchdog_piggyback_failed');
    }

    try {
      const fn = await notifyFotDistribution();
      log.info({ handler: 'tochka_sync', fot_candidates: fn.candidates, fot_notified: fn.notified }, 'fot_notify_piggyback');
    } catch (fnErr) {
      log.error({ handler: 'tochka_sync', error: String(fnErr) }, 'fot_notify_piggyback_failed');
    }

    try {
      const dr = await sendDailyReport();
      log.info({ handler: 'tochka_sync', daily_report_sent: dr.sent, sync_ok: result !== null }, 'daily_report_piggyback');
    } catch (drErr) {
      log.error({ handler: 'tochka_sync', error: String(drErr) }, 'daily_report_piggyback_failed');
    }
  }

  if (result !== null) {
    log.info(
      {
        handler: 'tochka_sync',
        latency_ms: Date.now() - start,
        added: result.added,
        balances_updated: result.balancesUpdated,
        classified: result.classified,
      },
      'tochka_sync_ok'
    );
    return {
      status: 200,
      body: {
        ok: true,
        added: result.added,
        balancesUpdated: result.balancesUpdated,
        classified: result.classified,
        dateTo: result.dateTo,
      },
    };
  }

  return { status: 200, body: { ok: false, error: syncError ?? 'sync failed' } };
};
