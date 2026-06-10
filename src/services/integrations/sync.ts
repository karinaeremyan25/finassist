import { z } from 'zod';
import { childLogger } from '../../utils/logger.js';
import type { SourceCode } from './types.js';
import {
  isSourceSyncEnabled,
  isSourceSyncRunning,
  createSyncRun,
  finishSyncRun,
  disableSource,
  getLastSuccessfulSync,
} from '../../db/repositories/integrations.js';
import { tochkaSyncer } from './tochka.js';
import { sendSyncErrorAlert, sendSourceDisabledAlert } from '../alerts.js';
import type { Bot } from 'grammy';
import type { BotContext } from '../../bot/middleware/auth.js';

/**
 * Оркестратор pull-синхронизации платёжных источников.
 *
 * ВАЖНО: Robokassa и Prodamus — push (webhook), они здесь НЕ синкаются.
 * Только Tochka использует pull (cron каждые 30 мин).
 *
 * Webhook-приёмники: POST /api/webhooks/robokassa, POST /api/webhooks/prodamus
 * (см. src/server/routes/webhooks.ts)
 *
 * syncSource('tochka') — синхронизирует Tochka:
 *   1. Проверяет sync_enabled.
 *   2. Проверяет нет ли уже running-запуска (параллельная защита).
 *   3. Создаёт sync_runs запись (status='running').
 *   4. Определяет sinceDate = last_successful - 1 день.
 *   5. Вызывает syncer.sync() с retry 3/1s/3s/9s.
 *   6. При 401/403 → disableSource + status='skipped_bad_credentials' + алерт.
 *   7. При других ошибках → status='error' + алерт.
 *   8. Финализирует sync_runs запись.
 *
 * syncAllSources() — синкает только Tochka.
 */

const log = childLogger({ handler: 'sync' });

/**
 * Pull-источники (cron). Robokassa и Prodamus исключены — они webhook-only.
 */
const PULL_SOURCE_CODE_SCHEMA = z.enum(['tochka']);

type PullSourceCode = z.infer<typeof PULL_SOURCE_CODE_SCHEMA>;

/** Для совместимости с типом SourceCode (используется в репозитории). */
const SOURCE_CODE_SCHEMA = z.enum(['robokassa', 'prodamus', 'tochka']);

const RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;
const MAX_ATTEMPTS = 3;

// ── Retry helper ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCredentialsError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'CredentialsError') return true;
    if (/401|403|unauthorized|forbidden/i.test(err.message)) return true;
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isCredentialsError(err)) throw err;
      log.warn({ source: label, attempt: attempt + 1, err: String(err) }, 'sync_retry_attempt');
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
    }
  }
  throw lastError;
}

// ── sinceDate helper ──────────────────────────────────────────────────────

async function getSinceDate(sourceCode: SourceCode): Promise<string> {
  const lastRun = await getLastSuccessfulSync(sourceCode);
  if (lastRun === null) {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(lastRun.startedAt);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Pull-синкеры (только Tochka) ──────────────────────────────────────────

const pullSyncers: Record<PullSourceCode, { sync(sinceDate: string): Promise<{ fetched: number; inserted: number }> }> = {
  tochka: tochkaSyncer,
};

// ── syncSource ────────────────────────────────────────────────────────────

/**
 * Синхронизирует один pull-источник (только 'tochka').
 * Все ошибки логируются; функция НЕ выбрасывает наружу.
 */
export async function syncSource(
  code: PullSourceCode,
  bot?: Bot<BotContext>
): Promise<void> {
  PULL_SOURCE_CODE_SCHEMA.parse(code);

  const startMs = Date.now();

  const isEnabled = await isSourceSyncEnabled(code);
  if (!isEnabled) {
    log.info({ source: code }, 'sync_source_disabled_skipping');
    return;
  }

  const isRunning = await isSourceSyncRunning(code);
  if (isRunning) {
    log.info({ source: code }, 'sync_source_already_running_skipping');
    return;
  }

  const syncRunId = await createSyncRun(code);
  log.info({ source: code, sync_run_id: syncRunId }, 'sync_source_started');

  let fetched = 0;
  let inserted = 0;
  let finished = false;

  try {
    const sinceDate = await getSinceDate(code);
    log.info({ source: code, since_date: sinceDate }, 'sync_source_since_date');

    const syncer = pullSyncers[code];
    const result = await withRetry(() => syncer.sync(sinceDate), code);

    fetched = result.fetched;
    inserted = result.inserted;

    await finishSyncRun(syncRunId, { status: 'ok', fetched, inserted });
    finished = true;

    log.info(
      { source: code, fetched, inserted, latency_ms: Date.now() - startMs },
      'sync_source_ok'
    );

  } catch (err) {
    const latencyMs = Date.now() - startMs;

    if (isCredentialsError(err)) {
      const reason = `HTTP 401/403 at ${new Date().toISOString()}`;
      await disableSource(code, reason);
      await finishSyncRun(syncRunId, {
        status: 'skipped_bad_credentials',
        fetched,
        inserted: 0,
        errorMessage: `credentials_invalid source=${code}`,
      });
      finished = true;

      log.error({ source: code, latency_ms: latencyMs }, 'sync_source_disabled_bad_credentials');

      if (bot) {
        await sendSourceDisabledAlert(bot, code, 'credentials_invalid').catch((alertErr) => {
          log.error({ err: alertErr, source: code }, 'sync_alert_send_failed');
        });
      }
    } else {
      const safeMessage = err instanceof Error
        ? err.message.replace(/key|password|secret|token|credential/gi, '[REDACTED]').slice(0, 500)
        : 'unknown_error';

      await finishSyncRun(syncRunId, {
        status: 'error',
        fetched,
        inserted: 0,
        errorMessage: `source=${code} ${safeMessage}`,
      });
      finished = true;

      log.error(
        { source: code, latency_ms: latencyMs, error_type: err instanceof Error ? err.name : 'unknown' },
        'sync_source_error'
      );

      if (bot) {
        await sendSyncErrorAlert(bot, code, safeMessage).catch((alertErr) => {
          log.error({ err: alertErr, source: code }, 'sync_alert_send_failed');
        });
      }
    }
  } finally {
    if (!finished) {
      await finishSyncRun(syncRunId, {
        status: 'error',
        fetched,
        inserted,
        errorMessage: `source=${code} unfinished`,
      }).catch((finErr) => {
        log.error({ err: finErr, source: code, sync_run_id: syncRunId }, 'sync_finish_guard_failed');
      });
    }
  }
}

// ── syncAllSources ────────────────────────────────────────────────────────

/**
 * Синхронизирует все pull-источники (только Tochka).
 * Robokassa и Prodamus — webhook-only, сюда не включены.
 */
export async function syncAllSources(bot?: Bot<BotContext>): Promise<void> {
  const startMs = Date.now();
  log.info({}, 'sync_all_sources_started');

  // Только pull-источники
  const PULL_SOURCES: PullSourceCode[] = ['tochka'];

  const results = await Promise.allSettled(
    PULL_SOURCES.map((code) => syncSource(code, bot))
  );

  let failedCount = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const code = PULL_SOURCES[i]!;
    if (result?.status === 'rejected') {
      failedCount++;
      log.error({ source: code, err: result.reason }, 'sync_all_source_settled_rejected');
    }
  }

  log.info(
    { total: PULL_SOURCES.length, failed: failedCount, latency_ms: Date.now() - startMs },
    'sync_all_sources_finished'
  );
}
