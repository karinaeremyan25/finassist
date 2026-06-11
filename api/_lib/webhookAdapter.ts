/**
 * Адаптер для webhook-функций (Robokassa / Prodamus).
 *
 * Чем отличается от _lib/adapter.ts
 * ---------------------------------
 * Платёжные провайдеры шлют `application/x-www-form-urlencoded`. Prodamus при
 * этом использует ВЛОЖЕННЫЕ ключи `products[0][name]`, а подпись вебхука
 * вычисляется по реконструированному вложенному объекту (см.
 * services/integrations/prodamus.ts → sortedDeep + JSON.stringify).
 *
 * Встроенный bodyParser Vercel НЕ воспроизводит эту вложенную структуру так же,
 * как VPS-сервер (src/server/http.ts → parseNestedFormFields). Если довериться
 * ему, подпись Prodamus не сойдётся. Поэтому здесь:
 *   1. Отключаем bodyParser (export const config ниже в каждой функции).
 *   2. Сами читаем сырой поток и реконструируем поля той же функцией
 *      parseNestedFormFields из скомпилированного бэкенда — байт-в-байт как VPS.
 *
 * Telegram-авторизации тут нет (это публичные платёжные вебхуки); аутентификация —
 * проверка подписи источника внутри самих обработчиков.
 */

import type { IncomingMessage } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { parseNestedFormFields } from '../../dist/server/http.js';
import type { ApiHandler, ApiRequest } from '../../dist/server/http.js';

/** Максимальный размер тела (256 KB) — паритет с VPS (защита от OOM/DoS). */
const MAX_BODY_BYTES = 256 * 1024;

/** Считывает сырое тело запроса как строку с лимитом размера. */
async function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Оборачивает webhook-ApiHandler в Vercel-функцию с ручным парсингом тела.
 * В файле функции обязательно экспортировать:
 *   export const config = { api: { bodyParser: false } };
 */
export function toVercelWebhook(handler: ApiHandler) {
  return async function webhookFn(
    req: VercelRequest,
    res: VercelResponse
  ): Promise<void> {
    const method = (req.method ?? 'POST').toUpperCase();
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? rawUrl;

    let rawStr: string;
    try {
      rawStr = await readRawBody(req);
    } catch {
      res.status(413).setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('bad sign');
      return;
    }

    const contentType = (req.headers['content-type'] ?? '').toLowerCase();
    let body: unknown;
    if (contentType.includes('application/json')) {
      try {
        body = rawStr.length > 0 ? (JSON.parse(rawStr) as unknown) : undefined;
      } catch {
        body = undefined;
      }
    } else {
      // application/x-www-form-urlencoded (включая вложенные products[i][...]).
      const params = new URLSearchParams(rawStr);
      body = parseNestedFormFields(params);
    }

    const apiReq: ApiRequest = {
      method,
      path,
      query: {},
      body,
      rawBody: rawStr.length > 0 ? rawStr : undefined,
      rawReq: req as unknown as IncomingMessage,
    };

    let apiRes;
    try {
      apiRes = await handler(apiReq);
    } catch {
      res.status(500).setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('bad sign');
      return;
    }

    res.status(apiRes.status);
    res.setHeader(
      'Content-Type',
      apiRes.contentType ?? 'text/plain; charset=utf-8'
    );
    res.send(apiRes.rawBody ?? '');
  };
}
