// POST /api/webhooks/robokassa — приём ResultURL Robokassa (подпись проверяется внутри).
// БЕЗ Telegram-авторизации: публичный HTTPS-эндпоинт, проверка подписи источника.
import { robokassaWebhookHandler } from '../../dist/server/routes/webhooks.js';
import { toVercelWebhook } from '../_lib/webhookAdapter.js';

// Отключаем встроенный bodyParser — тело читаем и парсим сами (паритет с VPS).
export const config = { api: { bodyParser: false } };

export default toVercelWebhook(robokassaWebhookHandler);
