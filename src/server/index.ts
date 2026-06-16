/**
 * Сборка HTTP-сервера Mini App:
 * - Создаёт Router и регистрирует все маршруты
 * - Экспортирует startHttpServer / stopHttpServer
 */

export { startHttpServer, stopHttpServer } from './http.js';
import { Router } from './http.js';
import { sessionHandler } from './routes/session.js';
import { summaryHandler, chartsHandler, insightsHandler, transactionsHandler } from './routes/analytics.js';
import { usersHandler } from './routes/users.js';
import { aiChatHandler } from './routes/aiChat.js';
import { robokassaWebhookHandler, prodamusWebhookHandler } from './routes/webhooks.js';
import { fundsHandler } from './routes/funds.js';
import { tochkaCallbackHandler } from './routes/tochka.js';
import { tochkaSyncHandler } from './routes/tochkaSync.js';
import { adminUsersHandler } from './routes/admin.js';
import { planHandler } from './routes/plan.js';
import {
  pnlHandler,
  pnlYearHandler,
  personalSpendingHandler,
  updateTxCategoryHandler,
} from './routes/pnl.js';

export function buildRouter(): Router {
  const router = new Router();

  // ── Webhook-приёмники (БЕЗ Telegram-авторизации, С проверкой подписи источника) ──
  // Robokassa ResultURL — настроить в ЛК Robokassa → Технические настройки → ResultURL
  router.post('/api/webhooks/robokassa', robokassaWebhookHandler);
  // Prodamus — настроить в ЛК Prodamus → Настройки → Уведомления → URL вебхука
  router.post('/api/webhooks/prodamus', prodamusWebhookHandler);

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

  // Mini App session
  router.post('/api/webapp/session', sessionHandler);

  // Analytics
  router.get('/api/analytics/summary', summaryHandler);
  router.get('/api/analytics/charts', chartsHandler);
  router.get('/api/analytics/insights', insightsHandler);
  router.get('/api/analytics/transactions', transactionsHandler);
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
  // PATCH без :param — id передаётся в теле запроса (Router делает exact match)
  router.add('PATCH', '/api/analytics/transactions/category', updateTxCategoryHandler);

  return router;
}

// redeploy 66bc720 — подхватить TOCHKA_JWT_TOKEN/CRON_SECRET
