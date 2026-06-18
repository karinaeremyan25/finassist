import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import type { RawSourceTransaction } from './types.js';
import type { Currency } from '../../types.js';
import { insertSyncTransactions } from '../../db/repositories/integrations.js';
import { sql } from '../../db/client.js';

/**
 * Lava.top — webhook-приёмник (push-модель, четвёртый источник дохода).
 *
 * Lava.top POST'ит JSON на URL, заданный в личном кабинете:
 *   ЛК Lava.top → API/вебхуки → URL = https://<домен>/api/webhooks/lava
 *
 * ── Подпись (подтверждено по lava-top-sdk) ───────────────────────────────
 *   - заголовок `signature`
 *   - HMAC-SHA256(rawBody, LAVA_WEBHOOK_SECRET), hex
 *   - сравнение constant-time (timingSafeEqual), регистр hex не важен
 *
 * ── Payload (JSON, поля из lava-top-sdk PurchaseWebhookLog) ───────────────
 *   eventType        — 'payment.success' | 'payment.failed' |
 *                      'subscription.recurring.payment.success' |
 *                      'subscription.recurring.payment.failed' |
 *                      'subscription.cancelled'
 *   contractId       — уникальный ID платежа → external_id
 *   parentContractId — для рекуррентов (опц.)
 *   product          — { id, title }; product.id → маппинг на продукт
 *   amount           — сумма (число, в основных единицах валюты)
 *   currency         — 'RUB' | 'USD' | 'EUR' | ...
 *   buyer.email      — email покупателя (НЕ логируем, НЕ храним)
 *   status, timestamp, clientUtm, errorMessage
 *
 * Создаём транзакцию ТОЛЬКО для успешных событий оплаты. Сумма → копейки
 * через utils/money.ts; конвертация валют в рубли — внутри
 * insertSyncTransactions (cbr.ts). Дедуп по external_id = `lava_<contractId>`.
 *
 * В лог — только метаданные (eventType, inserted, статус подписи). Без сумм,
 * email и тела запроса.
 */

const log = childLogger({ handler: 'webhook:lava' });

// ── Реальные ID юрлиц/направлений (см. SPEC) ──────────────────────────────
const ENTITY_IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const ENTITY_OOO = 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d';
const DIR_DPO = 'b17eb69e-4bd3-441f-8a0c-57734d56840c';
const DIR_METANOIA = 'ac773f21-0f0d-4772-8baf-15cac941c122';

/**
 * Маппинг product.id (оффер Lava.top) → юрлицо/направление/категория.
 *
 * TODO(Карина): вписать реальные product.id из ЛК Lava.top → Products.
 *   Курс ДПО  → ИП  / DPO      / lava_course
 *   Клуб      → ООО / METANOIA / lava_club
 * Пока маппинг пуст — немаппированные платежи падают на дефолтное юрлицо
 * источника (ИП) с категорией other_income (доход не теряется, см. fallback).
 */
const OFFER_MAP: Record<string, { entityId: string; directionId: string; categoryCode: string }> = {
  // 'PRODUCT_ID_КУРС': { entityId: ENTITY_IP,  directionId: DIR_DPO,      categoryCode: 'lava_course' },
  // 'PRODUCT_ID_КЛУБ': { entityId: ENTITY_OOO, directionId: DIR_METANOIA, categoryCode: 'lava_club' },
};

/** События успешной оплаты, по которым создаём доход. */
const SUCCESS_EVENTS = new Set<string>([
  'payment.success',
  'subscription.recurring.payment.success',
]);

// ── Zod-схема payload ─────────────────────────────────────────────────────

const LavaProductSchema = z
  .object({ id: z.string().optional(), title: z.string().optional() })
  .passthrough();

export const LavaWebhookSchema = z
  .object({
    eventType: z.string(),
    contractId: z.string().min(1),
    parentContractId: z.string().nullable().optional(),
    product: LavaProductSchema.optional(),
    amount: z.union([z.number(), z.string()]),
    currency: z.string().default('RUB'),
    status: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export type LavaWebhookPayload = z.infer<typeof LavaWebhookSchema>;

export interface WebhookResult {
  ok: boolean;
  responseBody: string;
  status: number;
}

// ── Подпись ───────────────────────────────────────────────────────────────

/**
 * Проверяет подпись Lava.top: HMAC-SHA256(rawBody, secret) hex == header `signature`.
 * Сравнение constant-time, регистр hex не важен.
 */
export function verifyLavaSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const exp = Buffer.from(expected.toLowerCase(), 'utf8');
  const got = Buffer.from(signature.toLowerCase(), 'utf8');
  if (exp.length !== got.length) return false;
  return crypto.timingSafeEqual(exp, got);
}

// ── Вспомогательные ───────────────────────────────────────────────────────

function normalizeCurrency(raw: string): Currency {
  const u = raw.toUpperCase();
  return u === 'RUB' || u === 'USD' || u === 'EUR' || u === 'KZT' ? (u as Currency) : 'OTHER';
}

/** ISO timestamp → YYYY-MM-DD (UTC). */
function normalizeDate(ts: string | undefined): string {
  if (ts) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts.trim());
    if (m) return m[1]!;
  }
  return new Date().toISOString().slice(0, 10);
}

// ── Обработчик webhook ────────────────────────────────────────────────────

/**
 * Обрабатывает входящий Lava.top webhook.
 * @param rawBody — сырое тело запроса (нужно для HMAC; нельзя пере-сериализовать).
 * @param signature — значение заголовка `signature`.
 */
export async function handleLavaWebhook(rawBody: string, signature: string): Promise<WebhookResult> {
  const secret = config.LAVA_WEBHOOK_SECRET;
  if (!secret) {
    log.warn({ source: 'lava' }, 'lava_webhook_secret_missing');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  // Проверка подписи
  if (!verifyLavaSignature(rawBody, signature, secret)) {
    log.warn({ source: 'lava', signature_ok: false }, 'lava_webhook_bad_signature');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }
  log.info({ source: 'lava', signature_ok: true }, 'lava_webhook_signature_ok');

  // Парсинг JSON
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    log.warn({ source: 'lava' }, 'lava_webhook_invalid_json');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  const parsed = LavaWebhookSchema.safeParse(json);
  if (!parsed.success) {
    log.warn({ source: 'lava', issues: parsed.error.issues.length }, 'lava_webhook_invalid_payload');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }
  const payload = parsed.data;

  // Только успешные события оплаты. Остальные (failed/cancelled) — 200, без записи.
  if (!SUCCESS_EVENTS.has(payload.eventType)) {
    log.info({ source: 'lava', event_type: payload.eventType }, 'lava_webhook_non_success_skipped');
    return { ok: true, status: 200, responseBody: 'ok' };
  }

  // Сумма → копейки
  let amount: bigint;
  try {
    amount = toKopecks(String(payload.amount));
    if (amount <= 0n) throw new Error('non-positive amount');
  } catch {
    log.warn({ source: 'lava' }, 'lava_webhook_invalid_amount');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  const currency = normalizeCurrency(payload.currency);
  const externalId = `lava_${payload.contractId}`;
  const occurredAt = normalizeDate(payload.timestamp);
  const productId = payload.product?.id ?? '';
  const productTitle = payload.product?.title ?? '';

  // Маппинг продукта → юрлицо/направление/категория (иначе fallback)
  const mapped = productId ? OFFER_MAP[productId] : undefined;
  let entityId: string;
  let directionId: string | null;
  let categoryCode: string;

  if (mapped) {
    entityId = mapped.entityId;
    directionId = mapped.directionId;
    categoryCode = mapped.categoryCode;
  } else {
    const srcRows = await sql<{ entity_id: string | null }[]>`
      SELECT entity_id FROM sources WHERE code = 'lava' LIMIT 1
    `;
    entityId = srcRows[0]?.entity_id ?? ENTITY_IP;
    directionId = null;
    categoryCode = 'other_income';
    log.warn(
      { source: 'lava', product_id_present: Boolean(productId) },
      'lava_webhook_offer_unmapped_fallback'
    );
  }

  // categoryId по коду (последовательно)
  const catRows = await sql<{ id: string }[]>`
    SELECT id FROM categories WHERE code = ${categoryCode} AND deleted_at IS NULL LIMIT 1
  `;
  const categoryId = catRows[0]?.id ?? null;

  const tx: RawSourceTransaction = {
    externalId,
    occurredAt,
    amount,
    currency,
    description: productTitle || null,
    // raw payload без персональных данных покупателя (email НЕ включаем)
    rawPayload: {
      eventType: payload.eventType,
      contractId: payload.contractId,
      productId,
      productTitle,
      currency,
    },
    // доход не классифицируется расходным классификатором
    needsClassification: false,
  };

  const inserted = await insertSyncTransactions({
    sourceCode: 'lava',
    transactions: [tx],
    createdBy: config.OWNER_TG_ID,
    entityId,
    directionId,
    categoryId,
    flowType: 'income',
  });

  log.info(
    { source: 'lava', event_type: payload.eventType, inserted, mapped: Boolean(mapped) },
    'lava_webhook_processed'
  );

  return { ok: true, status: 200, responseBody: 'ok' };
}
