/**
 * Единая Vercel-функция (catch-all) для ВСЕХ маршрутов /api/*.
 *
 * Зачем: на Hobby-плане Vercel лимит 12 serverless-функций. Раньше каждый
 * эндпоинт = отдельный файл = отдельная функция, и мы упирались в лимит.
 * Теперь один файл ловит все /api/*, а нужный обработчик находит существующий
 * Router (src/server/index.ts → buildRouter), как на VPS. Эндпоинтов можно
 * добавлять сколько угодно — функция по-прежнему одна.
 *
 * Импорты — только из СКОМПИЛИРОВАННОГО бэкенда (../dist/...js).
 */

import type { IncomingMessage } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { buildRouter } from '../dist/server/index.js';
import { bigintReplacer } from '../dist/server/http.js';
import type { ApiRequest } from '../dist/server/http.js';

// Роутер строится один раз на холодный старт инстанса.
const router = buildRouter();

function normalizeQuery(query: VercelRequest['query']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === 'string') out[key] = value[0];
    } else if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

function deriveRawBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  // OPTIONS (preflight) — same-origin в Telegram, CORS не нужен.
  if (method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?')[0] ?? rawUrl;

  // Health-check без авторизации.
  if (method === 'GET' && path === '/api/health') {
    res.status(200).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  const apiHandler = router.find(method, path);
  if (apiHandler === null) {
    res.status(404).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: { code: 'not_found', message: 'Маршрут не найден' } }));
    return;
  }

  const apiReq: ApiRequest = {
    method,
    path,
    query: normalizeQuery(req.query),
    body: req.body as unknown,
    rawBody: deriveRawBody(req.body),
    rawReq: req as unknown as IncomingMessage,
  };

  let apiRes;
  try {
    apiRes = await apiHandler(apiReq);
  } catch (err) {
    console.error(`[api_error] ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    res.status(500).setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: { code: 'internal_error', message: 'Внутренняя ошибка сервера' } }));
    return;
  }

  // Raw-текстовые ответы (вебхуки Robokassa/Prodamus → plain text).
  if (apiRes.rawBody !== undefined) {
    res.status(apiRes.status);
    res.setHeader('Content-Type', apiRes.contentType ?? 'text/plain; charset=utf-8');
    res.send(apiRes.rawBody);
    return;
  }

  res.status(apiRes.status);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(apiRes.body, bigintReplacer));
}
