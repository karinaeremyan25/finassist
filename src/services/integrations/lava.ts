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
  // '<offer_id ДПО Basic>':        { entityId: ENTITY_OOO, directionId: null, categoryCode: 'lava_course' },
  // '<offer_id ДПО Professional>': { entityId: ENTITY_OOO, directionId: null, categoryCode: 'lava_course' },
  // '<offer_id ДПО Expert>':       { entityId: ENTITY_OOO, directionId: null, categoryCode: 'lava_course' },
  // '<offer_id Club Metanoia>':    { entityId: ENTITY_IP,  directionId: null, categoryCode: 'lava_club' },
  // остальные офферы (сопровождение/консультации) → ИП / other_income (см. routeByTitle/дефолт)
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
