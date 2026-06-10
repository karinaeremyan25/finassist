import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import type { RawSourceTransaction } from './types.js';
import {
  insertSyncTransactions,
  getActiveProdamusMappings,
} from '../../db/repositories/integrations.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { sql } from '../../db/client.js';

/**
 * Robokassa — webhook-приёмник (push модель).
 *
 * Robokassa НЕ имеет API "список операций за период".
 * Робокасса POST'ит уведомления на ResultURL (наш эндпоинт).
 *
 * Настройка в личном кабинете Robokassa:
 *   Технические настройки → URL для уведомлений (ResultURL) =
 *   https://<домен>/api/webhooks/robokassa
 *
 * ── Алгоритм проверки подписи (ResultURL) ──────────────────────────────
 *
 * Входные параметры (form-urlencoded):
 *   OutSum       — сумма в рублях (строка, напр. "1500.00")
 *   InvId        — номер заказа (строка)
 *   SignatureValue — MD5 подпись от Robokassa
 *   Fee          — комиссия (опционально)
 *   EMail        — email покупателя (опционально)
 *   PaymentMethod — способ оплаты (опционально)
 *   Shp_*        — кастомные параметры, добавленные при создании заказа
 *
 * Строка подписи:
 *   base = "${OutSum}:${InvId}:${ROBOKASSA_PASSWORD}"   (Password2)
 *   Если есть Shp_* параметры — добавить В АЛФАВИТНОМ порядке ключей:
 *   base += ":Shp_key=value" для каждого
 *   MD5(base) hex → сравнить с SignatureValue (case-insensitive).
 *
 * Успешный ответ: текстовое тело "OK${InvId}" с Content-Type: text/plain, HTTP 200.
 * Неверная подпись: HTTP 400, тело "bad sign".
 */

const log = childLogger({ handler: 'webhook:robokassa' });

// ── Zod-схема входящего webhook-payload ──────────────────────────────────

export const RobokassaWebhookSchema = z.object({
  OutSum: z.string().min(1),
  InvId: z.union([z.string(), z.number()]).transform(String),
  SignatureValue: z.string().min(1),
  Fee: z.string().optional(),
  EMail: z.string().optional(),
  PaymentMethod: z.string().optional(),
}).passthrough(); // Shp_* и прочие поля пропускаются

export type RobokassaWebhookPayload = z.infer<typeof RobokassaWebhookSchema>;

// ── Результат обработки webhook ───────────────────────────────────────────

export interface WebhookResult {
  ok: boolean;
  /** HTTP-тело ответа для Robokassa. */
  responseBody: string;
  /** HTTP-статус ответа. */
  status: number;
}

// ── Проверка подписи ──────────────────────────────────────────────────────

/**
 * Извлекает Shp_* параметры из плоского объекта, сортирует по ключу.
 */
function extractShpParams(raw: Record<string, unknown>): Array<[string, string]> {
  const shpEntries: Array<[string, string]> = [];
  for (const key of Object.keys(raw)) {
    if (key.startsWith('Shp_')) {
      shpEntries.push([key, String(raw[key] ?? '')]);
    }
  }
  // Алфавитный порядок ключей — требование Robokassa
  shpEntries.sort((a, b) => a[0].localeCompare(b[0]));
  return shpEntries;
}

/**
 * Строит строку подписи для ResultURL Robokassa.
 * Формат: "${OutSum}:${InvId}:${Password2}[:Shp_key=value...]"
 */
function buildResultSignatureString(
  outSum: string,
  invId: string,
  password: string,
  shpParams: Array<[string, string]>
): string {
  let s = `${outSum}:${invId}:${password}`;
  for (const [key, value] of shpParams) {
    s += `:${key}=${value}`;
  }
  return s;
}

/**
 * Проверяет подпись Robokassa ResultURL.
 * Возвращает true при совпадении (case-insensitive).
 */
export function verifyRobokassaSignature(
  outSum: string,
  invId: string,
  signatureValue: string,
  password: string,
  rawPayload: Record<string, unknown>
): boolean {
  const shpParams = extractShpParams(rawPayload);
  const sigString = buildResultSignatureString(outSum, invId, password, shpParams);
  const expected = crypto.createHash('md5').update(sigString, 'utf8').digest('hex');
  return expected.toLowerCase() === signatureValue.toLowerCase();
}

// ── Маппинг описание → направление ───────────────────────────────────────

function matchMapping(
  description: string,
  mappings: Awaited<ReturnType<typeof getActiveProdamusMappings>>
): { directionId: string | null; entityId: string | null; categoryId: string | null } {
  const lower = description.toLowerCase();
  for (const m of mappings) {
    let matched = false;
    if (m.matchType === 'exact') {
      matched = description === m.productPattern;
    } else if (m.matchType === 'contains') {
      matched = lower.includes(m.productPattern.toLowerCase());
    } else if (m.matchType === 'regex') {
      try {
        matched = new RegExp(m.productPattern, 'i').test(description);
      } catch {
        matched = false;
      }
    }
    if (matched) {
      return { directionId: m.directionId, entityId: m.entityId, categoryId: m.categoryId };
    }
  }
  return { directionId: null, entityId: null, categoryId: null };
}

// ── Обработчик webhook ────────────────────────────────────────────────────

/**
 * Обрабатывает входящий Robokassa ResultURL webhook.
 * Проверяет подпись, вставляет транзакцию.
 * Возвращает тело и статус ответа.
 */
export async function handleRobokassaWebhook(
  rawFields: Record<string, unknown>
): Promise<WebhookResult> {
  const password = config.ROBOKASSA_PASSWORD;
  const merchantLogin = config.ROBOKASSA_MERCHANT_LOGIN;

  if (!password || !merchantLogin) {
    log.warn({ source: 'robokassa' }, 'robokassa_webhook_credentials_missing');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  // Zod-валидация входящего payload
  const parsed = RobokassaWebhookSchema.safeParse(rawFields);
  if (!parsed.success) {
    log.warn({ source: 'robokassa', issues: parsed.error.issues.length }, 'robokassa_webhook_invalid_payload');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  const { OutSum, InvId, SignatureValue } = parsed.data;

  // Проверка подписи
  const signOk = verifyRobokassaSignature(OutSum, InvId, SignatureValue, password, rawFields);
  if (!signOk) {
    // Логируем ТОЛЬКО метаданные — без суммы, email, тела
    log.warn(
      { source: 'robokassa', signature_ok: false },
      'robokassa_webhook_bad_signature'
    );
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  log.info({ source: 'robokassa', signature_ok: true }, 'robokassa_webhook_signature_ok');

  // Конвертация суммы: OutSum — рубли строкой ("1500.00")
  let amount: bigint;
  try {
    amount = toKopecks(OutSum);
    if (amount <= 0n) throw new Error('non-positive amount');
  } catch {
    log.warn({ source: 'robokassa' }, 'robokassa_webhook_invalid_amount');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  // Дата = сегодня (МСК = UTC+3, но храним UTC YYYY-MM-DD)
  const occurredAt = new Date().toISOString().slice(0, 10);

  // Описание из EMail / InvId (без персональных данных — EMail в rawPayload не пишем)
  const description = parsed.data.EMail
    ? `Robokassa InvId=${InvId}`
    : `Robokassa InvId=${InvId}`;

  // Маппинг через продуктовые правила (по EMail-адресу определить нельзя —
  // пробуем по описанию, скорее всего needs_classification=true)
  const mappings = await getActiveProdamusMappings();
  const mapping = description ? matchMapping(description, mappings) : null;

  const tx: RawSourceTransaction = {
    externalId: `robokassa_${InvId}`,
    occurredAt,
    amount,
    currency: 'RUB',
    description,
    rawPayload: {
      invId: InvId,
      paymentMethod: parsed.data.PaymentMethod ?? null,
      directionId: mapping?.directionId ?? null,
      entityId: mapping?.entityId ?? null,
      categoryId: mapping?.categoryId ?? null,
      // НЕ включаем OutSum, EMail, Fee — персональные/финансовые данные
    },
  };

  // entity_id из sources.entity_id для Robokassa (ИП Еремян)
  const entityRows = await sql<{ entity_id: string | null }[]>`
    SELECT entity_id FROM sources WHERE code = 'robokassa' LIMIT 1
  `;
  const entityId = entityRows[0]?.entity_id;
  if (!entityId) {
    log.warn({ source: 'robokassa' }, 'robokassa_webhook_entity_id_missing');
    return { ok: false, status: 500, responseBody: 'bad sign' };
  }

  // created_by = owner
  const users = await getAllActiveUsers();
  const owner = users.find((u) => u.role === 'owner');
  if (!owner) {
    log.warn({ source: 'robokassa' }, 'robokassa_webhook_no_owner');
    return { ok: false, status: 500, responseBody: 'bad sign' };
  }

  const inserted = await insertSyncTransactions({
    sourceCode: 'robokassa',
    transactions: [tx],
    createdBy: owner.id,
    entityId,
    directionId: mapping?.directionId ?? null,
    categoryId: mapping?.categoryId ?? null,
    flowType: 'income',
  });

  log.info({ source: 'robokassa', inserted }, 'robokassa_webhook_processed');

  // Robokassa ждёт ответа "OK${InvId}" как text/plain
  return { ok: true, status: 200, responseBody: `OK${InvId}` };
}
