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

// ── Реальные ID юрлиц (см. SPEC) ──────────────────────────────────────────
const ENTITY_IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const ENTITY_OOO = 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d';

/** Куда отнести платёж: юрлицо + (опц.) направление + категория P&L. */
interface Routing {
  entityId: string;
  directionId: string | null;
  categoryCode: string;
}

/**
 * Правило (решение владельца, 2026-06): ТОЛЬКО курсы ДПО → ООО;
 * всё остальное (клуб, сопровождение, консультации) → ИП.
 *
 * Точное сопоставление по product.id (offer_id). Заполнять, когда продукты
 * заведены в app.lava.top — API НЕ умеет создавать продукты. Пока пусто —
 * работает маршрутизация по названию (routeByTitle) + дефолт на ИП.
 *
 * Карта офферов (названия из LAVATOP_SPEC.md):
 *   ООО / lava_course:  «DPO Psychology of Health — Basic / Professional / Expert»
 *   ИП  / lava_club:    «Club Metanoia — Monthly Membership»
 *   ИП  / other_income: сопровождение и консультации (Karina/специалисты/студенты ДПО)
 */
const OFFER_MAP: Record<string, Routing> = {
  // Курсы ДПО → ООО / lava_course
  '23b0f5e3-8b5f-4a01-b74d-ca8dede00089': { entityId: ENTITY_OOO, directionId: null, categoryCode: 'lava_course' }, // ДПО Эксперт
  '096476fd-3208-46c3-a435-a4a173279365': { entityId: ENTITY_OOO, directionId: null, categoryCode: 'lava_course' }, // ДПО Профи
  'a6c9303c-7b45-4712-a4ac-e2cdee281570': { entityId: ENTITY_OOO, directionId: null, categoryCode: 'lava_course' }, // ДПО Базовый
  // Клуб Метанойя → ИП / lava_club
  'ceef20f2-e57c-42a7-9ca4-5f7962d7e792': { entityId: ENTITY_IP, directionId: null, categoryCode: 'lava_club' }, // Клуб Метанойя (подписка)
  // Сопровождение и консультации → ИП / other_income
  'ce9f74c8-ec05-42a1-8543-cdb66e7d92bc': { entityId: ENTITY_IP, directionId: null, categoryCode: 'other_income' }, // Сопровождение с Кариной
  '6cb77376-26b7-4af1-a237-12d1e54cbf2e': { entityId: ENTITY_IP, directionId: null, categoryCode: 'other_income' }, // Сопровождение с ГНМ-специалистом
  'dde305b5-d743-40b1-8801-741ab651f1d8': { entityId: ENTITY_IP, directionId: null, categoryCode: 'other_income' }, // Сопровождение с Дарьей (клуб)
  '91c72d01-967e-4753-862a-7612a8a80585': { entityId: ENTITY_IP, directionId: null, categoryCode: 'other_income' }, // Консультация с Кариной
  'cbc5f908-6d63-4a98-aa9f-91812991e08d': { entityId: ENTITY_IP, directionId: null, categoryCode: 'other_income' }, // Консультация с ГНМ-специалистом
};

/**
 * Маршрут по названию продукта (когда offer_id ещё не вписан в OFFER_MAP).
 * Реализует правило владельца: курс ДПО (Basic/Professional/Expert) → ООО,
 * клуб → ИП (категория «клуб»), остальное → ИП (дефолт, см. handler).
 */
function routeByTitle(title: string): Routing | null {
  const t = title.toLowerCase();
  const isConsult = /consult|консультац/.test(t);
  const isDpo = /dpo|дпо|psychology of health/.test(t);
  const isCourseTier = /basic|professional|expert|базов|проф|эксперт/.test(t);
  // Курс ДПО (тариф Basic/Professional/Expert), НЕ консультация → ООО
  if (isDpo && isCourseTier && !isConsult) {
    return { entityId: ENTITY_OOO, directionId: null, categoryCode: 'lava_course' };
  }
  // Клуб Метанойя → ИП, категория «клуб»
  if (/club|клуб|metanoia|метанойя/.test(t)) {
    return { entityId: ENTITY_IP, directionId: null, categoryCode: 'lava_club' };
  }
  // Сопровождение/консультации и прочее → дефолт (ИП / other_income) в handler
  return null;
}

/**
 * Успешная ли это оплата (создаём доход). Lava называет события по-разному
 * («Payment Result» / «Recurrent Payment»), а в теле приходят eventType и
 * status. Чтобы не потерять реальный платёж из-за расхождения строк, считаем
 * оплату успешной по eventType ИЛИ status, исключая явные fail/cancel/pending.
 *
 * Известные значения (SDK): eventType 'payment.success' /
 * 'subscription.recurring.payment.success'; status InvoiceStatus
 * ('completed' / 'subscription-active' и т.п.).
 */
function isSuccessfulPayment(eventType: string, status: string | undefined): boolean {
  const blob = `${eventType} ${status ?? ''}`.toLowerCase();
  const isNegative = /fail|cancel|decline|refund|pending|expire|error|new|progress/.test(blob);
  const isPositive = /success|paid|complete|active/.test(blob);
  return isPositive && !isNegative;
}

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

// ── Авторизация вебхука ─────────────────────────────────────────────────────

/** Данные аутентификации входящего вебхука Lava.top. */
export interface LavaAuthHeaders {
  /** HMAC-SHA256(rawBody) hex — заголовок `signature` (SDK-режим, если используется). */
  signature?: string;
  /**
   * Значения ВСЕХ входящих заголовков (строкой). Lava в режиме
   * «API key of your service» присылает секрет в каком-то заголовке —
   * имя заголовка не документировано, поэтому проверяем все значения.
   */
  candidates?: string[];
}

/** Constant-time сравнение двух строк. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Проверяет HMAC-подпись Lava.top: HMAC-SHA256(rawBody, secret) hex == `signature`.
 * Регистр hex не важен, сравнение constant-time.
 */
export function verifyLavaSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(expected.toLowerCase(), signature.toLowerCase());
}

/**
 * Авторизует вебхук Lava.top. ЛК Lava предлагает аутентификацию вебхука
 * «API key of your service» — секрет приходит в заголовке (имя не
 * документировано). Принимаем запрос, если предъявлено знание
 * `LAVA_WEBHOOK_SECRET` любым из способов:
 *   1) `signature` = HMAC-SHA256(rawBody, secret)  (если Lava подписывает тело)
 *   2) любой входящий заголовок == secret  или  `Bearer <secret>`  (режим «API key»)
 */
export function authorizeLavaWebhook(
  rawBody: string,
  auth: LavaAuthHeaders,
  secret: string
): boolean {
  if (auth.signature && verifyLavaSignature(rawBody, auth.signature, secret)) return true;
  const bearer = `Bearer ${secret}`;
  for (const value of auth.candidates ?? []) {
    if (!value) continue;
    if (safeEqual(value, secret)) return true;
    if (value.length === bearer.length && safeEqual(value, bearer)) return true;
  }
  return false;
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
 * @param auth — заголовки аутентификации (signature / X-Api-Key / Authorization).
 *   Для обратной совместимости допускается строка = значение заголовка `signature`.
 */
export async function handleLavaWebhook(
  rawBody: string,
  auth: LavaAuthHeaders | string
): Promise<WebhookResult> {
  const authHeaders: LavaAuthHeaders = typeof auth === 'string' ? { signature: auth } : auth;
  const secret = config.LAVA_WEBHOOK_SECRET;
  if (!secret) {
    log.warn({ source: 'lava' }, 'lava_webhook_secret_missing');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  // Авторизация (любой режим Lava: HMAC-подпись / API key / Authorization)
  if (!authorizeLavaWebhook(rawBody, authHeaders, secret)) {
    log.warn({ source: 'lava', auth_ok: false }, 'lava_webhook_unauthorized');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }
  log.info({ source: 'lava', auth_ok: true }, 'lava_webhook_authorized');

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

  // Только успешные события оплаты. Остальные (failed/cancelled/pending) — 200, без записи.
  if (!isSuccessfulPayment(payload.eventType, payload.status)) {
    log.info(
      { source: 'lava', event_type: payload.eventType, status: payload.status ?? null },
      'lava_webhook_non_success_skipped'
    );
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

  // Маршрутизация: точный offer_id → по названию → дефолт (ИП / прочий доход).
  // Правило владельца: только курсы ДПО → ООО, всё остальное → ИП.
  const routing = (productId ? OFFER_MAP[productId] : undefined) ?? routeByTitle(productTitle);
  let entityId: string;
  let directionId: string | null;
  let categoryCode: string;

  if (routing) {
    entityId = routing.entityId;
    directionId = routing.directionId;
    categoryCode = routing.categoryCode;
  } else {
    entityId = ENTITY_IP;
    directionId = null;
    categoryCode = 'other_income';
    log.info({ source: 'lava', product_id_present: Boolean(productId) }, 'lava_webhook_routed_default_ip');
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
    { source: 'lava', event_type: payload.eventType, inserted, entity: entityId === ENTITY_OOO ? 'ooo' : 'ip', category: categoryCode },
    'lava_webhook_processed'
  );

  return { ok: true, status: 200, responseBody: 'ok' };
}
