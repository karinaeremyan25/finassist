import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import type { SourceSyncer, SyncResult, RawSourceTransaction } from './types.js';
import {
  insertSyncTransactions,
  getActiveProdamusMappings,
  type ProductMappingRow,
} from '../../db/repositories/integrations.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { sql } from '../../db/client.js';

/**
 * Prodamus REST API синхронизатор.
 *
 * Переиспользует логику маппинга продукт → направление из
 * db/repositories/integrations.ts (prodamus_product_mapping), аналогично
 * services/parser/prodamus-csv.ts.
 *
 * ────────── ASSUMPTIONS (требуют сверки с реальной документацией) ──────────
 *
 * ASSUMPTION 1: endpoint
 *   Базовый URL: https://payform.ru/api
 *   Метод: GET /orders  (или /payments — уточнить в личном кабинете Продамуса)
 *   Документация: https://docs.payform.ru/api/
 *   Пример: https://payform.ru/api/orders?date_from=2024-01-01&date_to=2024-01-31
 *
 * ASSUMPTION 2: auth-схема
 *   Bearer-токен (API-ключ) в заголовке: Authorization: Bearer <PRODAMUS_API_KEY>
 *   PRODAMUS_API_KEY берётся из config.ts (env PRODAMUS_API_KEY).
 *
 * ASSUMPTION 3: формат ответа (JSON)
 *   { data: OrderItem[], total: number, page: number, per_page: number }
 *   OrderItem: {
 *     id: string,            — уникальный идентификатор заказа
 *     date: string,          — "YYYY-MM-DD HH:mm:ss" или ISO
 *     sum: string,           — сумма в рублях ("1500.00")
 *     currency: string,      — "RUB" (или другая)
 *     status: string,        — "paid" | "pending" | "failed" | ...
 *     product_name: string,  — наименование товара/курса
 *     payment_id: string,    — внешний id платёжной системы
 *   }
 *
 * ASSUMPTION 4: пагинация
 *   Параметры: page (начиная с 1), per_page (по умолчанию 100).
 *   Продолжаем пагинацию пока data.length === per_page.
 *
 * ASSUMPTION 5: фильтрация по дате
 *   Параметры: date_from, date_to (YYYY-MM-DD).
 *   Статус: только status='paid' (успешные платежи).
 *
 * ASSUMPTION 6: суммы
 *   sum — строка в рублях ("1500.00"). Конвертируем в копейки через round(sum * 100).
 *
 * ASSUMPTION 7: маппинг продукт → направление/юрлицо
 *   Используем prodamus_product_mapping (те же правила, что у CSV-импорта).
 *   Если product_name не совпал ни с одним правилом — entity из источника в БД,
 *   direction=null, needs_classification=true.
 * ──────────────────────────────────────────────────────────────────────────
 */

const log = childLogger({ handler: 'sync:prodamus' });

// ── Константы ────────────────────────────────────────────────────────────

// ASSUMPTION 1: базовый URL Prodamus API
const PRODAMUS_BASE_URL = 'https://payform.ru/api';
const PRODAMUS_ORDERS_PATH = '/orders';

const HTTP_TIMEOUT_MS = 30_000;
const PER_PAGE = 100;
// ASSUMPTION 3: статус успешного платежа
const SUCCESS_STATUSES = new Set(['paid', 'complete', 'success']);

// ── Zod-схема ответа ──────────────────────────────────────────────────────

const ProdamusOrderSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  date: z.string(),
  sum: z.string(),
  currency: z.string().default('RUB'),
  status: z.string(),
  product_name: z.string().default(''),
  // ASSUMPTION 3: payment_id может отсутствовать
  payment_id: z.union([z.string(), z.number()]).transform(String).optional(),
});

const ProdamusResponseSchema = z.object({
  data: z.array(ProdamusOrderSchema),
  total: z.number().optional(),
  page: z.number().optional(),
  per_page: z.number().optional(),
});

// ── Вспомогательные функции ───────────────────────────────────────────────

/** "1500.50" → 150050n копеек. Конвертация — через utils/money.ts (money.md). */
function parseRubToKopecks(raw: string): bigint {
  try {
    const kopecks = toKopecks(raw);
    return kopecks > 0n ? kopecks : 0n;
  } catch {
    return 0n;
  }
}

/** Нормализует дату Продамуса к YYYY-MM-DD. */
function normalizeDate(raw: string): string {
  const isoMatch = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  if (isoMatch) return isoMatch[1]!;
  // DD.MM.YYYY
  const dmyMatch = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(raw.trim());
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Маппинг product_name → {directionId, entityId, categoryId}.
 * Переиспользует правила из prodamus_product_mapping (как CSV-импорт).
 */
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

// ── CredentialsError ──────────────────────────────────────────────────────

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

// ── Запрос к API ─────────────────────────────────────────────────────────

async function fetchPage(
  apiKey: string,
  dateFrom: string,
  dateTo: string,
  page: number
): Promise<z.infer<typeof ProdamusResponseSchema>> {
  const params = new URLSearchParams({
    date_from: dateFrom,
    date_to: dateTo,
    status: 'paid',
    page: String(page),
    per_page: String(PER_PAGE),
  });

  const url = `${PRODAMUS_BASE_URL}${PRODAMUS_ORDERS_PATH}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let responseBody: string;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new CredentialsError(`Prodamus responded with HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`Prodamus HTTP ${res.status}`);
    }

    responseBody = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(responseBody);
  } catch {
    throw new Error('Prodamus: failed to parse JSON response');
  }

  const parsed = ProdamusResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Prodamus: unexpected response schema — ${parsed.error.message}`);
  }

  return parsed.data;
}

async function fetchAllOrders(
  apiKey: string,
  sinceDate: string
): Promise<RawSourceTransaction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const mappings = await getActiveProdamusMappings();
  const allTransactions: RawSourceTransaction[] = [];
  let page = 1;

  while (true) {
    const response = await fetchPage(apiKey, sinceDate, today, page);

    if (response.data.length === 0) break;

    for (const order of response.data) {
      if (!SUCCESS_STATUSES.has(order.status.toLowerCase())) continue;

      const amount = parseRubToKopecks(order.sum);
      if (amount <= 0n) continue;

      const occurredAt = normalizeDate(order.date);
      const productName = order.product_name;

      // Маппинг продукта → направление/юрлицо (хранится в rawPayload для sync.ts)
      const mapping = applyProductMapping(productName, mappings);

      // Приоритет: payment_id → id для external_id (уникальность в источнике)
      const externalId = `prodamus_${order.payment_id ?? order.id}`;

      allTransactions.push({
        externalId,
        occurredAt,
        amount,
        currency: (order.currency.toUpperCase() as 'RUB' | 'USD' | 'EUR' | 'KZT') ?? 'RUB',
        description: productName || null,
        rawPayload: {
          orderId: order.id,
          productName,
          directionId: mapping.directionId,
          entityId: mapping.entityId,
          categoryId: mapping.categoryId,
          // НЕ включаем персональные данные покупателя
        },
      });
    }

    // Если меньше per_page — последняя страница
    if (response.data.length < PER_PAGE) break;

    page++;
  }

  return allTransactions;
}

// ── Тип для группировки по entity/direction/category ─────────────────────

interface TxGroup {
  entityId: string;
  directionId: string | null;
  categoryId: string | null;
  transactions: RawSourceTransaction[];
}

// ── SourceSyncer implementation ───────────────────────────────────────────

export const prodamusSyncer: SourceSyncer = {
  code: 'prodamus',

  async sync(sinceDate: string): Promise<SyncResult> {
    const apiKey = config.PRODAMUS_API_KEY;

    if (!apiKey) {
      log.warn({ source: 'prodamus' }, 'prodamus_api_key_missing');
      return { fetched: 0, inserted: 0 };
    }

    const raw = await fetchAllOrders(apiKey, sinceDate);
    log.info({ source: 'prodamus', fetched: raw.length }, 'prodamus_fetched');

    if (raw.length === 0) return { fetched: 0, inserted: 0 };

    // Резолвим дефолтный entity_id из sources.entity_id для prodamus
    const entityRows = await sql<{ entity_id: string | null }[]>`
      SELECT entity_id FROM sources WHERE code = 'prodamus' LIMIT 1
    `;
    const defaultEntityId = entityRows[0]?.entity_id;

    // Получаем owner для created_by
    const users = await getAllActiveUsers();
    const owner = users.find((u) => u.role === 'owner');
    if (!owner) {
      log.warn({ source: 'prodamus' }, 'prodamus_no_owner_user');
      return { fetched: raw.length, inserted: 0 };
    }

    // Группируем транзакции по entity/direction/category из rawPayload
    const groups = new Map<string, TxGroup>();
    for (const tx of raw) {
      const directionId = (tx.rawPayload['directionId'] as string | null) ?? null;
      const entityId = (tx.rawPayload['entityId'] as string | null) ?? defaultEntityId ?? '';
      const categoryId = (tx.rawPayload['categoryId'] as string | null) ?? null;

      if (!entityId) {
        log.warn({ source: 'prodamus', external_id: tx.externalId }, 'prodamus_no_entity_id');
        continue;
      }

      const key = `${entityId}__${directionId ?? 'null'}__${categoryId ?? 'null'}`;
      const existing = groups.get(key);
      if (existing) {
        existing.transactions.push(tx);
      } else {
        groups.set(key, { entityId, directionId, categoryId, transactions: [tx] });
      }
    }

    let totalInserted = 0;

    for (const group of groups.values()) {
      const inserted = await insertSyncTransactions({
        sourceCode: 'prodamus',
        transactions: group.transactions,
        createdBy: owner.id,
        entityId: group.entityId,
        directionId: group.directionId,
        categoryId: group.categoryId,
        flowType: 'income',
      });
      totalInserted += inserted;
    }

    return { fetched: raw.length, inserted: totalInserted };
  },
};
