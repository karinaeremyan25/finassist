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

export function buildRouter(): Router {
  const router = new Router();

  // ── Webhook-приёмники (БЕЗ Telegram-авторизации, С проверкой подписи источника) ──
  // Robokassa ResultURL — настроить в ЛК Robokassa → Технические настройки → ResultURL
  router.post('/api/webhooks/robokassa', robokassaWebhookHandler);
  // Prodamus — настроить в ЛК Prodamus → Настройки → Уведомления → URL вебхука
  router.post('/api/webhooks/prodamus', prodamusWebhookHandler);

  // Mini App session
  router.post('/api/webapp/session', sessionHandler);

  // Analytics
  router.get('/api/analytics/summary', summaryHandler);
  router.get('/api/analytics/charts', chartsHandler);
  router.get('/api/analytics/insights', insightsHandler);
  router.get('/api/analytics/transactions', transactionsHandler);

  // Users
  router.get('/api/webapp/users', usersHandler);

  // AI chat (two paths per spec)
  router.post('/api/ai-chat', aiChatHandler);
  router.post('/api/webapp/ai/chat', aiChatHandler);

  return router;
}
