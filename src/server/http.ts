import http from 'node:http';
import { URL } from 'node:url';
import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { serveStatic } from './static.js';

const log = childLogger({ handler: 'http' });

// ── Types ──────────────────────────────────────────────────────────────────

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /**
   * Для JSON-запросов — распарсенный объект.
   * Для urlencoded-запросов — реконструированный объект (включая вложенные products[]).
   * Для прочих Content-Type — undefined.
   */
  body: unknown;
  /**
   * Сырая строка тела запроса.
   * Доступна для JSON и urlencoded (нужна для диагностики и проверки подписей).
   */
  rawBody: string | undefined;
  rawReq: http.IncomingMessage;
}

export type ApiHandler = (req: ApiRequest) => Promise<ApiResponse>;

export interface ApiResponse {
  status: number;
  /**
   * Для JSON-ответов: любой сериализуемый объект.
   * Если задан rawBody — body игнорируется.
   */
  body: unknown;
  /**
   * Если задано — отправляется как есть вместо JSON.stringify(body).
   */
  rawBody?: string;
  /**
   * Content-Type ответа. По умолчанию 'application/json'.
   */
  contentType?: string;
}

export interface RouteEntry {
  method: string;
  path: string;
  handler: ApiHandler;
}

// ── bigint → number serialiser ─────────────────────────────────────────────

/**
 * JSON.stringify replacer: converts bigint values to JS number.
 * Amounts in this project are kopecks, well within Number.MAX_SAFE_INTEGER
 * (~9 * 10^15 >> 10^13 kopecks). No division — the front-end formats itself.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

// ── CORS helpers ───────────────────────────────────────────────────────────

function setCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: string[]
): void {
  if (allowedOrigins.length === 0) {
    return;
  }

  const origin = req.headers['origin'];
  if (origin !== undefined && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
}

// ── Form key parser (nested urlencoded) ───────────────────────────────────

/**
 * Реконструирует вложенный объект из плоских urlencoded-ключей.
 *
 * Примеры:
 *   products[0][name] → { products: [{ name: ... }] }
 *   Shp_field         → { Shp_field: ... }
 *
 * Используется для Prodamus webhook, где products — вложенный массив.
 */
export function parseNestedFormFields(
  params: URLSearchParams
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  params.forEach((value, key) => {
    // Проверяем паттерн key[index][field] или key[field]
    const arrayMatch = /^([^\[]+)\[(\d+)\]\[([^\]]+)\]$/.exec(key);
    if (arrayMatch !== null) {
      const [, parentKey, indexStr, fieldKey] = arrayMatch;
      const index = parseInt(indexStr!, 10);

      if (!(parentKey! in result)) {
        result[parentKey!] = [];
      }
      const arr = result[parentKey!] as Record<string, unknown>[];
      // Заполняем недостающие слоты
      while (arr.length <= index) {
        arr.push({});
      }
      arr[index]![fieldKey!] = value;
      return;
    }

    // Простой key[field] (без индекса)
    const objMatch = /^([^\[]+)\[([^\]]+)\]$/.exec(key);
    if (objMatch !== null) {
      const [, parentKey, fieldKey] = objMatch;
      if (!(parentKey! in result)) {
        result[parentKey!] = {};
      }
      (result[parentKey!] as Record<string, unknown>)[fieldKey!] = value;
      return;
    }

    // Плоский ключ
    result[key] = value;
  });

  return result;
}

// ── Body reader ────────────────────────────────────────────────────────────

/** Класс ошибки «тело слишком большое» (→ HTTP 413). */
class PayloadTooLargeError extends Error {}

/** Максимальный размер тела запроса (256 KB) — защита от OOM/DoS. */
const MAX_BODY_BYTES = 256 * 1024;

interface ReadBodyResult {
  body: unknown;
  rawBody: string | undefined;
}

async function readBody(req: http.IncomingMessage): Promise<ReadBodyResult> {
  const contentType = req.headers['content-type'] ?? '';

  const isJson = contentType.includes('application/json');
  const isUrlEncoded = contentType.includes('application/x-www-form-urlencoded');

  if (!isJson && !isUrlEncoded) {
    return { body: undefined, rawBody: undefined };
  }

  return new Promise<ReadBodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const rawStr = Buffer.concat(chunks).toString('utf-8');

      if (rawStr.length === 0) {
        resolve({ body: undefined, rawBody: undefined });
        return;
      }

      if (isJson) {
        try {
          resolve({ body: JSON.parse(rawStr) as unknown, rawBody: rawStr });
        } catch {
          resolve({ body: undefined, rawBody: rawStr });
        }
        return;
      }

      // application/x-www-form-urlencoded
      if (isUrlEncoded) {
        try {
          const params = new URLSearchParams(rawStr);
          const nested = parseNestedFormFields(params);
          resolve({ body: nested, rawBody: rawStr });
        } catch {
          resolve({ body: undefined, rawBody: rawStr });
        }
        return;
      }

      resolve({ body: undefined, rawBody: undefined });
    });

    req.on('error', reject);
  });
}

// ── Router ─────────────────────────────────────────────────────────────────

export class Router {
  private routes: RouteEntry[] = [];

  add(method: string, path: string, handler: ApiHandler): void {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  get(path: string, handler: ApiHandler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: ApiHandler): void {
    this.add('POST', path, handler);
  }

  find(method: string, path: string): ApiHandler | null {
    const upper = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method === upper && route.path === path) {
        return route.handler;
      }
    }
    return null;
  }
}

// ── Server factory ─────────────────────────────────────────────────────────

export function createHttpServer(router: Router): http.Server {
  const allowedOrigins = config.WEBAPP_ALLOWED_ORIGINS;

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';

    const parsed = new URL(rawUrl, 'http://localhost');
    const pathname = parsed.pathname;

    setCorsHeaders(req, res, allowedOrigins);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health-check (no auth required)
    if (method === 'GET' && pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jsonStringify({ status: 'ok', timestamp: new Date().toISOString() }));
      log.info({ handler: 'health', latency_ms: Date.now() - start }, 'health_ok');
      return;
    }

    // ── Static file serving ───────────────────────────────────────────────
    if (method === 'GET' && !pathname.startsWith('/api')) {
      try {
        const handled = await serveStatic(req, res, pathname, config.WEBAPP_STATIC_DIR);
        if (handled) return;
      } catch (err) {
        log.error({ err, handler: 'static', pathname, latency_ms: Date.now() - start }, 'static_error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(jsonStringify({ error: { code: 'internal_error', message: 'Ошибка при отдаче файла' } }));
        return;
      }
    }

    const handler = router.find(method, pathname);

    if (handler === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(jsonStringify({ error: { code: 'not_found', message: 'Маршрут не найден' } }));
      return;
    }

    // Build query map
    const query: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    let body: unknown;
    let rawBody: string | undefined;
    try {
      const result = await readBody(req);
      body = result.body;
      rawBody = result.rawBody;
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(jsonStringify({ error: { code: 'payload_too_large', message: 'Тело запроса слишком большое' } }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonStringify({ error: { code: 'bad_request', message: 'Невалидное тело запроса' } }));
      return;
    }

    const apiReq: ApiRequest = { method, path: pathname, query, body, rawBody, rawReq: req };

    try {
      const apiRes = await handler(apiReq);

      // Поддержка raw text ответов (для webhook-приёмников Robokassa/Prodamus)
      if (apiRes.rawBody !== undefined) {
        const ct = apiRes.contentType ?? 'text/plain; charset=utf-8';
        res.writeHead(apiRes.status, { 'Content-Type': ct });
        res.end(apiRes.rawBody);
      } else {
        res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
        res.end(jsonStringify(apiRes.body));
      }

      log.info(
        { handler: pathname, method, status: apiRes.status, latency_ms: Date.now() - start },
        'http_request'
      );
    } catch (err) {
      log.error(
        { err, handler: pathname, method, latency_ms: Date.now() - start },
        'http_handler_error'
      );
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(jsonStringify({ error: { code: 'internal_error', message: 'Внутренняя ошибка сервера' } }));
    }
  });

  return server;
}

// ── Start / stop ───────────────────────────────────────────────────────────

let _server: http.Server | null = null;

export async function startHttpServer(port: number, router: Router): Promise<http.Server> {
  const server = createHttpServer(router);
  _server = server;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      log.info({ port }, 'http_server_started');
      resolve();
    });
  });

  return server;
}

export async function stopHttpServer(): Promise<void> {
  if (_server === null) return;
  const server = _server;
  _server = null;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err !== undefined) reject(err);
      else resolve();
    });
  });
  log.info('http_server_stopped');
}
