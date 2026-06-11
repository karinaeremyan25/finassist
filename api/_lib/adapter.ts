/**
 * Адаптер Vercel Serverless Function → существующий ApiHandler.
 *
 * Назначение
 * ----------
 * Текущие обработчики Mini App (src/server/routes/*.ts) принимают собственный
 * тип `ApiRequest` ({ method, path, query, body, rawBody, rawReq }) и возвращают
 * `ApiResponse` ({ status, body, rawBody?, contentType? }). На VPS их вызывает
 * самописный HTTP-роутер (src/server/http.ts). На Vercel роутинг делает платформа
 * (файл = маршрут), поэтому здесь мы лишь конвертируем входящий VercelRequest в
 * `ApiRequest`, зовём готовый обработчик и сериализуем `ApiResponse` в ответ.
 *
 * Импорты: только из СКОМПИЛИРОВАННОГО бэкенда (../../dist/...js).
 * Build-команда Vercel сначала гонит `npm run build` (tsc → dist), поэтому к
 * моменту бандлинга функций esbuild видит реальные .js-файлы и не спотыкается
 * на NodeNext-импортах вида `./x.js`, где исходник — `x.ts`.
 *
 * bigint-сериализация: суммы в проекте — копейки (BIGINT → JS bigint). Используем
 * тот же replacer, что и VPS-сервер (dist/server/http.js#bigintReplacer), чтобы
 * формат ответов был идентичным.
 */

import type { IncomingMessage } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { bigintReplacer } from '../../dist/server/http.js';
import type { ApiHandler, ApiRequest } from '../../dist/server/http.js';

/**
 * Нормализует req.query Vercel (string | string[]) в плоский
 * Record<string,string>, как ожидает существующий ApiRequest.query.
 * При повторяющихся ключах берём первое значение (поведение URLSearchParams).
 */
function normalizeQuery(query: VercelRequest['query']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === 'string') {
        out[key] = value[0];
      }
    } else if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Реконструирует «сырое» тело запроса в строку (нужно вебхукам для проверки
 * подписи и диагностики). Vercel уже распарсил body в объект, поэтому для
 * rawBody мы JSON-сериализуем объект. Для строкового body — отдаём как есть.
 * Бинарные/прочие тела не используются нашими маршрутами.
 */
function deriveRawBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}

/**
 * Оборачивает существующий ApiHandler в стандартную Vercel-функцию.
 *
 * Пример (api/webapp/users.ts):
 *   import { usersHandler } from '../../dist/server/routes/users.js';
 *   export default toVercel(usersHandler);
 */
export function toVercel(handler: ApiHandler) {
  return async function vercelHandler(
    req: VercelRequest,
    res: VercelResponse
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();

    // OPTIONS (preflight) — same-origin в Telegram, CORS не нужен; отвечаем 204.
    if (method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    // pathname без query-строки
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? rawUrl;

    const apiReq: ApiRequest = {
      method,
      path,
      query: normalizeQuery(req.query),
      body: req.body as unknown,
      rawBody: deriveRawBody(req.body),
      // VercelRequest extends node:http IncomingMessage — обработчики читают
      // только req.rawReq.headers[...], что полностью совместимо.
      rawReq: req as unknown as IncomingMessage,
    };

    let apiRes;
    try {
      apiRes = await handler(apiReq);
    } catch {
      // Обработчики бросают неперехваченные ошибки наружу (на VPS их ловит
      // src/server/http.ts). Здесь воспроизводим тот же контракт: 500 + JSON.
      res.status(500);
      res.setHeader('Content-Type', 'application/json');
      res.send(
        JSON.stringify({
          error: { code: 'internal_error', message: 'Внутренняя ошибка сервера' },
        })
      );
      return;
    }

    // Raw-текстовые ответы (вебхуки Robokassa/Prodamus возвращают plain text).
    if (apiRes.rawBody !== undefined) {
      res.status(apiRes.status);
      res.setHeader(
        'Content-Type',
        apiRes.contentType ?? 'text/plain; charset=utf-8'
      );
      res.send(apiRes.rawBody);
      return;
    }

    // JSON-ответ с тем же bigint-replacer, что и на VPS.
    res.status(apiRes.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(apiRes.body, bigintReplacer));
  };
}
