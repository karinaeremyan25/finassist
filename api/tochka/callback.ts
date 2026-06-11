/**
 * GET /api/tochka/callback — Точка OAuth authorization_code callback.
 *
 * Точка редиректит сюда после consent пользователя с параметром ?code=...
 * Обработчик меняет code на tokens и сохраняет refresh_token в settings.
 * Возвращает HTML-страницу «Точка подключена, можно закрыть окно».
 *
 * БЕЗ Telegram-авторизации (OAuth redirect открывается браузером).
 * Авторизация обеспечивается уникальностью кода (однократное использование).
 */
import { tochkaCallbackHandler } from '../../dist/server/routes/tochka.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(tochkaCallbackHandler);
