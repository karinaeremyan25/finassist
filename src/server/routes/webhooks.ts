import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';
import { handleRobokassaWebhook } from '../../services/integrations/robokassa.js';
import { handleProdamusWebhook } from '../../services/integrations/prodamus.js';
import { handleLavaWebhook } from '../../services/integrations/lava.js';

/**
 * Webhook-приёмники платёжных источников.
 *
 * Маршруты (POST, без Telegram-авторизации, но с проверкой подписи источника):
 *   POST /api/webhooks/robokassa  — Robokassa ResultURL
 *   POST /api/webhooks/prodamus   — Prodamus уведомление
 *
 * Content-Type входящих запросов:
 *   Robokassa: application/x-www-form-urlencoded
 *   Prodamus:  application/x-www-form-urlencoded (включая products[i][...])
 *
 * Аутентификация: проверка подписи источника (не X-Telegram-Init-Data).
 * Логирование: только метаданные (источник, статус подписи, кол-во),
 *              суммы/email/тела НЕ логируются.
 */

const log = childLogger({ handler: 'webhook' });

// ── Robokassa ResultURL ───────────────────────────────────────────────────

export const robokassaWebhookHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const startMs = Date.now();

  // body — реконструированный объект из urlencoded (см. http.ts parseNestedFormFields)
  const rawFields = req.body as Record<string, unknown> | undefined;

  if (rawFields === undefined || typeof rawFields !== 'object' || rawFields === null) {
    log.warn({ source: 'robokassa', latency_ms: Date.now() - startMs }, 'robokassa_webhook_empty_body');
    return {
      status: 400,
      body: null,
      rawBody: 'bad sign',
      contentType: 'text/plain; charset=utf-8',
    };
  }

  let result: Awaited<ReturnType<typeof handleRobokassaWebhook>>;
  try {
    result = await handleRobokassaWebhook(rawFields);
  } catch (err) {
    // Не логируем детали (могут содержать суммы/данные)
    log.error(
      { source: 'robokassa', latency_ms: Date.now() - startMs, err_name: err instanceof Error ? err.name : 'unknown' },
      'robokassa_webhook_error'
    );
    return {
      status: 500,
      body: null,
      rawBody: 'bad sign',
      contentType: 'text/plain; charset=utf-8',
    };
  }

  log.info(
    { source: 'robokassa', ok: result.ok, status: result.status, latency_ms: Date.now() - startMs },
    'robokassa_webhook_done'
  );

  return {
    status: result.status,
    body: null,
    rawBody: result.responseBody,
    contentType: 'text/plain; charset=utf-8',
  };
};

// ── Lava.top ────────────────────────────────────────────────────────────────

export const lavaWebhookHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const startMs = Date.now();

  // Lava.top: подпись считается HMAC над СЫРЫМ телом → нужен req.rawBody.
  const rawBody = req.rawBody;
  if (rawBody === undefined || rawBody.length === 0) {
    log.warn({ source: 'lava', latency_ms: Date.now() - startMs }, 'lava_webhook_empty_body');
    return { status: 400, body: null, rawBody: 'bad sign', contentType: 'text/plain; charset=utf-8' };
  }

  // Lava (режим «API key of your service») присылает секрет в каком-то заголовке —
  // имя не документировано, поэтому собираем значения ВСЕХ заголовков как кандидаты.
  // Заголовок `signature` отдаём отдельно для HMAC-режима (если Lava подписывает тело).
  const headers = req.rawReq.headers;
  const flat = (v: string | string[] | undefined): string[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  const sigHeader = headers['signature'];
  const signature = Array.isArray(sigHeader) ? (sigHeader[0] ?? '') : (sigHeader ?? '');
  const candidates = Object.values(headers).flatMap(flat);

  let result: Awaited<ReturnType<typeof handleLavaWebhook>>;
  try {
    result = await handleLavaWebhook(rawBody, { signature, candidates });
  } catch (err) {
    log.error(
      { source: 'lava', latency_ms: Date.now() - startMs, err_name: err instanceof Error ? err.name : 'unknown' },
      'lava_webhook_error'
    );
    // 200, чтобы Lava не ретраила бесконечно при внутренней ошибке (дедуп защитит от дублей)
    return { status: 200, body: null, rawBody: 'ok', contentType: 'text/plain; charset=utf-8' };
  }

  log.info(
    { source: 'lava', ok: result.ok, status: result.status, latency_ms: Date.now() - startMs },
    'lava_webhook_done'
  );

  return {
    status: result.status,
    body: null,
    rawBody: result.responseBody,
    contentType: 'text/plain; charset=utf-8',
  };
};

// ── Prodamus ──────────────────────────────────────────────────────────────

export const prodamusWebhookHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const startMs = Date.now();

  const rawFields = req.body as Record<string, unknown> | undefined;

  if (rawFields === undefined || typeof rawFields !== 'object' || rawFields === null) {
    log.warn({ source: 'prodamus', latency_ms: Date.now() - startMs }, 'prodamus_webhook_empty_body');
    return {
      status: 400,
      body: null,
      rawBody: 'bad sign',
      contentType: 'text/plain; charset=utf-8',
    };
  }

  // Подпись Prodamus приходит в заголовке Sign
  const signHeader = req.rawReq.headers['sign'];
  const signValue = Array.isArray(signHeader) ? signHeader[0] : signHeader;

  if (signValue === undefined || signValue.length === 0) {
    log.warn({ source: 'prodamus', latency_ms: Date.now() - startMs }, 'prodamus_webhook_missing_sign_header');
    return {
      status: 400,
      body: null,
      rawBody: 'bad sign',
      contentType: 'text/plain; charset=utf-8',
    };
  }

  let result: Awaited<ReturnType<typeof handleProdamusWebhook>>;
  try {
    result = await handleProdamusWebhook(rawFields, signValue);
  } catch (err) {
    log.error(
      { source: 'prodamus', latency_ms: Date.now() - startMs, err_name: err instanceof Error ? err.name : 'unknown' },
      'prodamus_webhook_error'
    );
    return {
      status: 500,
      body: null,
      rawBody: 'bad sign',
      contentType: 'text/plain; charset=utf-8',
    };
  }

  log.info(
    { source: 'prodamus', ok: result.ok, status: result.status, latency_ms: Date.now() - startMs },
    'prodamus_webhook_done'
  );

  return {
    status: result.status,
    body: null,
    rawBody: result.responseBody,
    contentType: 'text/plain; charset=utf-8',
  };
};
