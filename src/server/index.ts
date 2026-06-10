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

export function buildRouter(): Router {
  const router = new Router();

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
