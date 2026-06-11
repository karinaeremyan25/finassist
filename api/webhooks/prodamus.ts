// POST /api/webhooks/prodamus — приём уведомлений Prodamus (подпись в заголовке Sign).
// БЕЗ Telegram-авторизации: публичный HTTPS-эндпоинт, проверка подписи источника.
// Вложенные products[i][...] реконструируются как на VPS — иначе подпись не сойдётся.
import { prodamusWebhookHandler } from '../../dist/server/routes/webhooks.js';
import { toVercelWebhook } from '../_lib/webhookAdapter.js';

// Отключаем встроенный bodyParser — тело читаем и парсим сами (паритет с VPS).
export const config = { api: { bodyParser: false } };

export default toVercelWebhook(prodamusWebhookHandler);
