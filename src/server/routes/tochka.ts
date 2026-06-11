/**
 * Точка OAuth callback handler.
 *
 * GET /api/tochka/callback?code=...
 *
 * Точка редиректит сюда после consent пользователя.
 * Обменивает code на tokens, сохраняет refresh_token в settings.
 * Возвращает HTML-страницу «Точка подключена».
 *
 * ASSUMPTION D (из tochka.ts): POST https://enter.tochka.com/connect/token
 * с grant_type=authorization_code обменивает code на access_token + refresh_token.
 */

import { z } from 'zod';
import { exchangeCodeForTokens, CredentialsError } from '../../services/integrations/tochka.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'tochka:callback' });

const CallbackQuerySchema = z.object({
  code: z.string().min(1),
  // Точка может передавать state для CSRF-защиты (пока не используем)
  state: z.string().optional(),
});

// HTML-ответы (минимальные, без внешних ресурсов)
const HTML_SUCCESS = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>Точка подключена</title></head>
<body>
<h2>Точка успешно подключена</h2>
<p>Токен авторизации сохранён. Можно закрыть это окно.</p>
</body>
</html>`;

const HTML_ERROR = (reason: string): string =>
  `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><title>Ошибка подключения Точки</title></head>
<body>
<h2>Ошибка подключения Точки</h2>
<p>${reason}</p>
<p>Попробуйте снова или свяжитесь с администратором.</p>
</body>
</html>`;

/**
 * GET /api/tochka/callback
 *
 * Принимает code от Точки, обменивает на токены, сохраняет refresh_token.
 * НЕ требует Telegram-авторизации (это OAuth callback, открывается браузером).
 */
export const tochkaCallbackHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    // Валидация query-параметров
    const parsed = CallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      log.warn({ handler: 'tochka_callback', latency_ms: Date.now() - start }, 'tochka_callback_missing_code');
      return {
        status: 400,
        body: null,
        rawBody: HTML_ERROR('Отсутствует параметр code в запросе.'),
        contentType: 'text/html; charset=utf-8',
      };
    }

    const { code } = parsed.data;

    // Обмен code → tokens + сохранение refresh_token в settings
    await exchangeCodeForTokens(code);

    log.info(
      { handler: 'tochka_callback', latency_ms: Date.now() - start },
      'tochka_callback_success'
    );

    return {
      status: 200,
      body: null,
      rawBody: HTML_SUCCESS,
      contentType: 'text/html; charset=utf-8',
    };
  } catch (err) {
    const errName = err instanceof Error ? err.name : 'unknown';
    const isCredErr = err instanceof CredentialsError;

    log.error(
      { handler: 'tochka_callback', err_name: errName, latency_ms: Date.now() - start },
      'tochka_callback_error'
    );

    const reason = isCredErr
      ? 'Неверные учётные данные приложения Точки (client_id / client_secret).'
      : 'Не удалось обменять code на токены. Проверьте настройки приложения в Точке.';

    return {
      status: 500,
      body: null,
      rawBody: HTML_ERROR(reason),
      contentType: 'text/html; charset=utf-8',
    };
  }
};
