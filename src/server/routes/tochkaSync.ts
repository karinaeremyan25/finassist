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

  try {
    const result = await syncTochka();

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.error(
      {
        handler: 'tochka_sync',
        latency_ms: Date.now() - start,
        // Не логируем сам токен — только сообщение об ошибке
        error: message,
      },
      'tochka_sync_error'
    );

    return {
      status: 200,
      body: { ok: false, error: message },
    };
  }
};
