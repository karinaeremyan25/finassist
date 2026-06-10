import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import type { RawSourceTransaction } from './types.js';
import {
  insertSyncTransactions,
  getActiveProdamusMappings,
  type ProductMappingRow,
} from '../../db/repositories/integrations.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { sql } from '../../db/client.js';

/**
 * Prodamus — webhook-приёмник (push модель).
 *
 * Prodamus НЕ имеет API "список заказов за период" (в публичном REST).
 * Продамус POST'ит уведомления на URL, заданный в настройках.
 *
 * Настройка в личном кабинете Prodamus:
 *   Настройки → Уведомления → URL вебхука =
 *   https://<домен>/api/webhooks/prodamus
 *
 * ── Алгоритм проверки подписи (Prodamus HMAC, PHP-совместимый) ────────
 *
 * 1. Взять все POST-поля (включая вложенные products[i][...]).
 * 2. РЕКУРСИВНО отсортировать по ключам.
 * 3. Все значения привести к строкам.
 * 4. JSON.stringify результирующего объекта.
 * 5. Экранировать прямые слэши: "/" → "\/" (как PHP json_encode по умолчанию).
 * 6. HMAC-SHA256(jsonString, secretKey) hex.
 * 7. Сравнить с заголовком Sign (hex, case-insensitive).
 *
 * ⚠️ ВАЖНО: сверить на реальном вебхуке Prodamus — PHP json_encode
 * может иметь особенности (unicode escape, пробелы), которые здесь
 * воспроизведены максимально точно, но требуют тестирования.
 *
 * Входные поля (form-urlencoded, вложенные как products[0][name]):
 *   order_id / order_num — идентификатор заказа
 *   sum                  — сумма в рублях ("1500.00")
 *   currency             — валюта (по умолч. "rub")
 *   date                 — дата ("YYYY-MM-DD HH:mm:ss" или ISO)
 *   payment_status       — "success" для успешных
 *   products[]           — массив товаров (name, price, quantity, sum)
 *   customer_email       — email покупателя (опционально)
 *   customer_phone       — телефон покупателя (опционально)
 *
 * Секрет: PRODAMUS_SECRET_KEY из env (отдельный от PRODAMUS_API_KEY).
 *
 * Ответ при успехе: HTTP 200 text/plain "success".
 * Ответ при ошибке подписи: HTTP 400.
 */

const log = childLogger({ handler: 'webhook:prodamus' });

// ── Zod-схема продукта Prodamus ───────────────────────────────────────────

const ProdamusProductSchema = z.object({
  name: z.string().default(''),
  price: z.union([z.string(), z.number()]).transform(String).optional(),
  quantity: z.union([z.string(), z.number()]).transform(String).optional(),
  sum: z.union([z.string(), z.number()]).transform(String).optional(),
}).passthrough();

// ── Zod-схема входящего webhook payload ──────────────────────────────────

export const ProdamusWebhookSchema = z.object({
  order_id: z.union([z.string(), z.number()]).transform(String).optional(),
  order_num: z.union([z.string(), z.number()]).transform(String).optional(),
  sum: z.string(),
  currency: z.string().default('rub'),
  date: z.string(),
  payment_status: z.string(),
  products: z.array(ProdamusProductSchema).default([]),
  customer_email: z.string().optional(),
  customer_phone: z.string().optional(),
}).passthrough();

export type ProdamusWebhookPayload = z.infer<typeof ProdamusWebhookSchema>;

// ── Результат обработки webhook ───────────────────────────────────────────

export interface WebhookResult {
  ok: boolean;
  responseBody: string;
  status: number;
}

// ── HMAC подпись (PHP-совместимая) ────────────────────────────────────────

/**
 * Рекурсивно сортирует объект/массив по ключам (как PHP ksort).
 * Все листовые значения приводятся к строкам (как PHP строковые поля формы).
 */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Массивы: рекурсивно обрабатываем элементы, ключи числовые — сортировать не нужно
    // (PHP ksort числового массива оставляет порядок как есть по числовому индексу)
    return value.map(sortedDeep);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortedDeep(obj[key]);
    }
    return sorted;
  }
  // Листовые значения → строки (как PHP form fields)
  return String(value ?? '');
}

/**
 * Сериализует объект в JSON с экранированием слэшей (как PHP json_encode).
 * PHP по умолчанию экранирует "/" → "\/".
 *
 * ⚠️ ВАЖНО: сверить на реальном вебхуке Prodamus.
 */
function phpCompatibleJsonStringify(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return '{}';
  // PHP json_encode экранирует прямые слэши / → \/
  return json.replace(/\//g, '\\/');
}

/**
 * Вычисляет HMAC-SHA256 подпись в стиле Prodamus PHP SDK.
 *
 * ⚠️ ВАЖНО: сверить на реальном вебхуке Prodamus — реализовано по PHP-референсу,
 * но без тестирования на живом потоке. Возможны отличия в unicode-escape PHP.
 */
export function computeProdamusSignature(
  fields: Record<string, unknown>,
  secretKey: string
): string {
  const sorted = sortedDeep(fields);
  const jsonStr = phpCompatibleJsonStringify(sorted);
  return crypto.createHmac('sha256', secretKey).update(jsonStr, 'utf8').digest('hex');
}

/**
 * Проверяет подпись Prodamus из заголовка Sign.
 */
export function verifyProdamusSignature(
  fields: Record<string, unknown>,
  signHeader: string,
  secretKey: string
): boolean {
  const expected = computeProdamusSignature(fields, secretKey);
  return expected.toLowerCase() === signHeader.toLowerCase();
}

// ── Вспомогательные функции ───────────────────────────────────────────────

/** Нормализует дату Продамуса к YYYY-MM-DD. */
function normalizeDate(raw: string): string {
  const isoMatch = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  if (isoMatch) return isoMatch[1]!;
  const dmyMatch = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(raw.trim());
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
  }
  return new Date().toISOString().slice(0, 10);
}

/** Маппинг product_name → {directionId, entityId, categoryId}. */
function applyProductMapping(
  productName: string,
  mappings: ProductMappingRow[]
): { directionId: string | null; entityId: string | null; categoryId: string | null } {
  const lower = productName.toLowerCase();
  for (const m of mappings) {
    let matched = false;
    if (m.matchType === 'exact') {
      matched = productName === m.productPattern;
    } else if (m.matchType === 'contains') {
      matched = lower.includes(m.productPattern.toLowerCase());
    } else if (m.matchType === 'regex') {
      try {
        matched = new RegExp(m.productPattern, 'i').test(productName);
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
 * Обрабатывает входящий Prodamus webhook.
 * @param rawFields — плоские поля из urlencoded тела (products уже реконструированы как массив)
 * @param signHeader — значение заголовка Sign
 */
export async function handleProdamusWebhook(
  rawFields: Record<string, unknown>,
  signHeader: string
): Promise<WebhookResult> {
  const secretKey = config.PRODAMUS_SECRET_KEY;

  if (!secretKey) {
    log.warn({ source: 'prodamus' }, 'prodamus_webhook_secret_key_missing');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  // Проверка подписи
  const signOk = verifyProdamusSignature(rawFields, signHeader, secretKey);
  if (!signOk) {
    log.warn(
      { source: 'prodamus', signature_ok: false },
      'prodamus_webhook_bad_signature'
    );
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  log.info({ source: 'prodamus', signature_ok: true }, 'prodamus_webhook_signature_ok');

  // Zod-валидация payload
  const parsed = ProdamusWebhookSchema.safeParse(rawFields);
  if (!parsed.success) {
    log.warn({ source: 'prodamus', issues: parsed.error.issues.length }, 'prodamus_webhook_invalid_payload');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  const payload = parsed.data;

  // Только успешные платежи
  if (payload.payment_status.toLowerCase() !== 'success') {
    log.info({ source: 'prodamus', payment_status: payload.payment_status }, 'prodamus_webhook_not_success_skipped');
    return { ok: true, status: 200, responseBody: 'success' };
  }

  // Сумма
  let amount: bigint;
  try {
    amount = toKopecks(payload.sum);
    if (amount <= 0n) throw new Error('non-positive amount');
  } catch {
    log.warn({ source: 'prodamus' }, 'prodamus_webhook_invalid_amount');
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  // external_id: order_num предпочтительнее order_id
  const externalId = `prodamus_${payload.order_num ?? payload.order_id ?? Date.now()}`;
  const occurredAt = normalizeDate(payload.date);

  // Наименование из первого продукта (основной товар)
  const firstProduct = payload.products[0];
  const productName = firstProduct?.name ?? '';

  // Маппинг через prodamus_product_mapping
  const mappings = await getActiveProdamusMappings();
  const mapping = applyProductMapping(productName, mappings);

  // Валюта
  const currency = payload.currency.toUpperCase() === 'RUB' ? 'RUB' : 'RUB'; // Prodamus обычно rub/RUB

  const tx: RawSourceTransaction = {
    externalId,
    occurredAt,
    amount,
    currency,
    description: productName || null,
    rawPayload: {
      orderId: payload.order_id ?? null,
      orderNum: payload.order_num ?? null,
      productsCount: payload.products.length,
      productName,
      directionId: mapping.directionId,
      entityId: mapping.entityId,
      categoryId: mapping.categoryId,
      // НЕ включаем customer_email, customer_phone, sum
    },
  };

  // entity_id из sources
  const entityRows = await sql<{ entity_id: string | null }[]>`
    SELECT entity_id FROM sources WHERE code = 'prodamus' LIMIT 1
  `;
  const defaultEntityId = entityRows[0]?.entity_id;
  const entityId = mapping.entityId ?? defaultEntityId;

  if (!entityId) {
    log.warn({ source: 'prodamus' }, 'prodamus_webhook_entity_id_missing');
    return { ok: false, status: 500, responseBody: 'bad sign' };
  }

  const users = await getAllActiveUsers();
  const owner = users.find((u) => u.role === 'owner');
  if (!owner) {
    log.warn({ source: 'prodamus' }, 'prodamus_webhook_no_owner');
    return { ok: false, status: 500, responseBody: 'bad sign' };
  }

  const inserted = await insertSyncTransactions({
    sourceCode: 'prodamus',
    transactions: [tx],
    createdBy: owner.id,
    entityId,
    directionId: mapping.directionId,
    categoryId: mapping.categoryId,
    flowType: 'income',
  });

  log.info({ source: 'prodamus', inserted, products_count: payload.products.length }, 'prodamus_webhook_processed');

  return { ok: true, status: 200, responseBody: 'success' };
}
