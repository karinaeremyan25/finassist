/**
 * Сборка HTTP-сервера Mini App:
 * - Создаёт Router и регистрирует все маршруты
 * - Экспортирует startHttpServer / stopHttpServer
 */

export { startHttpServer, stopHttpServer } from './http.js';
import { Router } from './http.js';
import { sessionHandler } from './routes/session.js';
import { summaryHandler, chartsHandler, insightsHandler, transactionsHandler, exportHandler } from './routes/analytics.js';
import { usersHandler } from './routes/users.js';
import { aiChatHandler } from './routes/aiChat.js';
import { robokassaWebhookHandler, prodamusWebhookHandler, lavaWebhookHandler } from './routes/webhooks.js';
import { fundsHandler } from './routes/funds.js';
import { tochkaCallbackHandler } from './routes/tochka.js';
import { tochkaSyncHandler } from './routes/tochkaSync.js';
import { adminUsersHandler } from './routes/admin.js';
import { planHandler } from './routes/plan.js';
import {
  pnlHandler,
  pnlYearHandler,
  personalSpendingHandler,
  pnlInTransitHandler,
  incomeBreakdownHandler,
  updateTxCategoryHandler,
} from './routes/pnl.js';
import { employeesHandler, employeeTransactionsHandler, employeesAnalyticsHandler, employeesExportHandler } from './routes/employees.js';
import { contractorsHandler, contractorsSyncHandler, invoiceGenerateHandler } from './routes/contractors.js';
import { aiCommandsHandler, aiCommandApproveHandler, aiAssistantHandler, aiTranscribeHandler, aiImportImageHandler, aiImportConfirmHandler } from './routes/aiCommands.js';
import { loansListHandler } from './routes/loans.js';
import { lavaProbeHandler } from './routes/lavaProbe.js';

export function buildRouter(): Router {
  const router = new Router();

  // ── Webhook-приёмники (БЕЗ Telegram-авторизации, С проверкой подписи источника) ──
  // Robokassa ResultURL — настроить в ЛК Robokassa → Технические настройки → ResultURL
  router.post('/api/webhooks/robokassa', robokassaWebhookHandler);
  // Prodamus — настроить в ЛК Prodamus → Настройки → Уведомления → URL вебхука
  router.post('/api/webhooks/prodamus', prodamusWebhookHandler);
  // Lava.top — настроить в ЛК Lava.top → API/вебхуки → URL = /api/webhooks/lava
  router.post('/api/webhooks/lava', lavaWebhookHandler);

  // ── Точка OAuth callback (БЕЗ Telegram-авторизации — OAuth redirect) ─────
  // Redirect URL в кабинете разработчика Точки = TOCHKA_REDIRECT_URI
  router.get('/api/tochka/callback', tochkaCallbackHandler);

  // ── Точка: ручная/cron синхронизация выписок ──────────────────────────────
  // Authorization: Bearer <CRON_SECRET> → cron-путь (без Telegram initData).
  // X-Telegram-Init-Data → кнопка «Обновить» в Mini App (resolveWebAppUser).
  router.add('POST', '/api/tochka/sync', tochkaSyncHandler);
  // Vercel Cron дёргает путь методом GET — регистрируем и его (та же авторизация
  // по CRON_SECRET внутри handler).
  router.add('GET', '/api/tochka/sync', tochkaSyncHandler);
  // ВРЕМЕННО: проба API Lava (выяснить эндпоинты «в проверке»). Удалить после.
  router.add('GET', '/api/lava/probe', lavaProbeHandler);

  // Mini App session
  router.post('/api/webapp/session', sessionHandler);

  // Analytics
  router.get('/api/analytics/summary', summaryHandler);
  router.get('/api/analytics/charts', chartsHandler);
  router.get('/api/analytics/insights', insightsHandler);
  router.get('/api/analytics/transactions', transactionsHandler);
  // Выгрузка операций в CSV — бот присылает файл в чат
  router.get('/api/analytics/export', exportHandler);
  router.get('/api/analytics/funds', fundsHandler);

  // Users
  router.get('/api/webapp/users', usersHandler);

  // AI chat (two paths per spec)
  router.post('/api/ai-chat', aiChatHandler);
  router.post('/api/webapp/ai/chat', aiChatHandler);

  // Admin: управление пользователями (owner-only, все методы в одном handler)
  router.add('GET',    '/api/admin/users', adminUsersHandler);
  router.add('POST',   '/api/admin/users', adminUsersHandler);
  router.add('PATCH',  '/api/admin/users', adminUsersHandler);
  router.add('DELETE', '/api/admin/users', adminUsersHandler);

  // Plan/fact по месяцам
  router.get('/api/analytics/plan', planHandler);
  router.post('/api/analytics/plan', planHandler);

  // P&L (feature-spec-pnl.md)
  // Порядок важен: /api/analytics/pnl/year регистрируем ДО /api/analytics/pnl,
  // иначе роутер (exact match) их не перепутает — они разные строки.
  router.get('/api/analytics/pnl/year', pnlYearHandler);
  router.get('/api/analytics/pnl', pnlHandler);
  router.get('/api/analytics/personal-spending', personalSpendingHandler);
  // Деньги в пути (US-104): доход/расход с выделением pending + налог по нетто
  router.get('/api/analytics/pnl/in-transit', pnlInTransitHandler);
  router.get('/api/analytics/income-breakdown', incomeBreakdownHandler);
  // PATCH без :param — id передаётся в теле запроса (Router делает exact match)
  router.add('PATCH', '/api/analytics/transactions/category', updateTxCategoryHandler);

  // ── ФОТ (US-101) ──────────────────────────────────────────────────────────
  // Exact-match роутер: id сотрудника передаётся в query (?id=) / теле.
  router.add('GET',   '/api/employees', employeesHandler);
  router.add('POST',  '/api/employees', employeesHandler);
  router.add('PATCH', '/api/employees', employeesHandler);
  router.get('/api/employees/transactions', employeeTransactionsHandler);
  router.get('/api/employees/analytics', employeesAnalyticsHandler);
  router.get('/api/employees/export', employeesExportHandler);

  // ── Контрагенты и счета (US-102) ──────────────────────────────────────────
  router.add('GET',   '/api/contractors', contractorsHandler);
  router.add('POST',  '/api/contractors', contractorsHandler);
  router.add('PATCH', '/api/contractors', contractorsHandler);
  router.post('/api/contractors/sync', contractorsSyncHandler);
  router.post('/api/invoices/generate', invoiceGenerateHandler);

  // ── Кредиты ────────────────────────────────────────────────────────────────
  router.get('/api/loans', loansListHandler);

  // ── AI-ассистент: наставник + оркестратор в одном (US-105) ────────────────
  router.post('/api/ai/assistant', aiAssistantHandler);
  router.post('/api/ai/transcribe', aiTranscribeHandler);
  // Импорт операций по скриншоту физ-карты (карта Лилианы и др.)
  router.post('/api/ai/import-image', aiImportImageHandler);
  router.post('/api/ai/import/confirm', aiImportConfirmHandler);
  router.post('/api/ai/commands', aiCommandsHandler);
  router.post('/api/ai/commands/approve', aiCommandApproveHandler);

  return router;
}

// redeploy 66bc720 — подхватить TOCHKA_JWT_TOKEN/CRON_SECRET
