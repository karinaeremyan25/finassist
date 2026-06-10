import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { sql, disconnect } from './db/client.js';
import { createBot } from './bot/bot.js';
import { fetchAndStoreFxRates } from './services/cbr.js';
import { checkTaxFund, sendWeeklySummary } from './services/alerts.js';
import { clearExpiredSessions } from './db/repositories/sessions.js';
import { childLogger } from './utils/logger.js';
import { startHttpServer, stopHttpServer, buildRouter } from './server/index.js';
import { syncAllSources } from './services/integrations/sync.js';

const log = childLogger({ handler: 'main' });

async function main(): Promise<void> {
  log.info({ node_env: config.NODE_ENV }, 'finassist_starting');

  // Verify DB connection
  try {
    await sql`SELECT 1`;
    log.info('db_connected');
  } catch (err) {
    log.fatal({ err }, 'db_connection_failed');
    process.exit(1);
  }

  const bot = createBot();

  // ── HTTP server for Mini App ───────────────────────────────────────────
  const router = buildRouter();
  await startHttpServer(config.WEBAPP_PORT, router);
  log.info({ port: config.WEBAPP_PORT }, 'http_server_ready');

  // ── Cron tasks (UTC) ──────────────────────────────────────────────────────

  // 06:00 UTC daily — fetch CBR exchange rates
  cron.schedule('0 6 * * *', async () => {
    try {
      await fetchAndStoreFxRates();
      log.info('cron_cbr_ok');
    } catch (err) {
      log.error({ err }, 'cron_cbr_error');
    }
  });

  // 06:00 UTC every Monday — weekly summary (09:00 MSK)
  cron.schedule('0 6 * * 1', async () => {
    try {
      await sendWeeklySummary(bot as never);
      log.info('cron_weekly_summary_ok');
    } catch (err) {
      log.error({ err }, 'cron_weekly_summary_error');
    }
  });

  // 07:00 UTC daily — tax fund alert check
  cron.schedule('0 7 * * *', async () => {
    try {
      await checkTaxFund(bot as never);
      log.info('cron_tax_check_ok');
    } catch (err) {
      log.error({ err }, 'cron_tax_check_error');
    }
  });

  // 03:00 UTC daily — clean up uploads/unparsed older than 7 days
  cron.schedule('0 3 * * *', async () => {
    try {
      const dir = 'uploads/unparsed';
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.unlink(filePath).catch(() => {});
          removed++;
        }
      }
      log.info({ removed }, 'cron_cleanup_ok');
    } catch (err) {
      log.error({ err }, 'cron_cleanup_error');
    }
  });

  // Every 15 minutes — clear expired FSM sessions
  cron.schedule('*/15 * * * *', async () => {
    try {
      const count = await clearExpiredSessions();
      if (count > 0) log.info({ count }, 'cron_sessions_cleared');
    } catch (err) {
      log.error({ err }, 'cron_sessions_error');
    }
  });

  // Every 30 minutes — sync payment sources (Robokassa, Prodamus, Tochka)
  // TODO: когда будет готов канал доставки (Mini App push/Telegram channel) —
  //       добавить здесь вызов generateDailyFinancialReport() и отправку.
  //       Сейчас функция есть в services/miniApp.ts, но канала доставки нет.
  cron.schedule('*/30 * * * *', async () => {
    try {
      await syncAllSources(bot as never);
      log.info('cron_sync_ok');
    } catch (err) {
      log.error({ err }, 'cron_sync_error');
    }
  });

  // 10:00 UTC daily — recalculate transactions where amount_rub is NULL (fx fallback)
  cron.schedule('0 10 * * *', async () => {
    try {
      const rows = await sql<{ id: string; currency: string; amount: bigint; occurred_at: string }[]>`
        SELECT id, currency, amount, occurred_at::text
        FROM transactions
        WHERE amount_rub IS NULL
          AND currency != 'RUB'
          AND deleted_at IS NULL
        LIMIT 100
      `;

      if (rows.length === 0) return;

      const { convertToRub } = await import('./services/cbr.js');
      let updated = 0;
      for (const row of rows) {
        try {
          const { amountRub } = await convertToRub(row.amount, row.currency, row.occurred_at.slice(0, 10));
          await sql`UPDATE transactions SET amount_rub = ${amountRub} WHERE id = ${row.id}`;
          updated++;
        } catch {
          // Skip individual failures
        }
      }
      log.info({ updated }, 'cron_fx_recalc_ok');
    } catch (err) {
      log.error({ err }, 'cron_fx_recalc_error');
    }
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    log.info({ signal }, 'finassist_stopping');
    try {
      await bot.stop();
      log.info('bot_stopped');
    } catch (err) {
      log.error({ err }, 'bot_stop_error');
    }
    try {
      await stopHttpServer();
      log.info('http_server_stopped');
    } catch (err) {
      log.error({ err }, 'http_stop_error');
    }
    try {
      await disconnect();
      log.info('db_disconnected');
    } catch (err) {
      log.error({ err }, 'db_disconnect_error');
    }
    process.exit(0);
  }

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });

  // ── Start bot ─────────────────────────────────────────────────────────────

  log.info('bot_starting');
  await bot.start({
    onStart: (info) => {
      log.info({ username: info.username }, 'bot_started');
    },
  });
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'fatal_startup_error');
  process.exit(1);
});
