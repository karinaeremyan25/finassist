import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import type { SourceSyncer, SyncResult, RawSourceTransaction } from './types.js';
import { insertSyncTransactions, getActiveProdamusMappings } from '../../db/repositories/integrations.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { sql } from '../../db/client.js';

/**
 * Robokassa REST API синхронизатор.
 *
 * ────────── ASSUMPTIONS (требуют сверки с реальной документацией) ──────────
 *
 * ASSUMPTION 1: endpoint
 *   Базовый URL: https://merchant.robokassa.ru/Merchant/WebService/Service.asmx
 *   Используемый метод: GetOperationList
 *   Документация: https://docs.robokassa.ru/#3693 (Merchant WebService)
 *   Запрос передаётся как GET с query-параметрами.
 *
 * ASSUMPTION 2: auth-схема
 *   MD5-подпись: SignatureValue = md5(MerchantLogin:StartDate:EndDate:Password2)
 *   Password2 — второй пароль магазина (для серверных операций).
 *   Параметр в запросе: SignatureValue.
 *   ВАЖНО: Robokassa может использовать SHA256 вместо MD5 в новых API.
 *          Необходимо уточнить в настройках магазина (раздел «Алгоритм подписи»).
 *
 * ASSUMPTION 3: формат ответа
 *   Robokassa возвращает XML или JSON в зависимости от Accept-заголовка.
 *   Здесь предполагается JSON-ответ (Accept: application/json).
 *   Структура ответа: { Result: { Code: number }, Items: OperationItem[] }
 *   OperationItem: { InvId: string, OutSum: string, IncSum: string,
 *                    StateCode: number, RequestDate: string, StateDate: string }
 *   StateCode=100 — успешная операция (оплачено).
 *
 * ASSUMPTION 4: суммы
 *   OutSum — сумма в рублях (float-строка "1500.00").
 *   Конвертируем в копейки умножением на 100 с Math.round.
 *
 * ASSUMPTION 5: пагинация
 *   Метод GetOperationList поддерживает параметры StartDate/EndDate (строки
 *   в формате "DD.MM.YYYY HH:mm:ss"). Без пагинации — возвращает все
 *   операции за период. Если операций очень много — нужна дополнительная пагинация.
 *
 * ASSUMPTION 6: entity и direction
 *   Robokassa привязана к ИП Еремян (entity_code='ip_eremyan').
 *   direction_id определяется через продуктовый маппинг (prodamus_product_mapping)
 *   по описанию операции; если не совпало — needs_classification=true.
 * ──────────────────────────────────────────────────────────────────────────
 */

const log = childLogger({ handler: 'sync:robokassa' });

// ── Константы (endpoint, пути) ────────────────────────────────────────────

// ASSUMPTION 1: базовый URL Robokassa Merchant WebService
const ROBOKASSA_BASE_URL = 'https://merchant.robokassa.ru/Merchant/WebService/Service.asmx';
const ROBOKASSA_OPERATION_LIST_PATH = '/GetOperationList';

const HTTP_TIMEOUT_MS = 30_000;
// Коды успешной операции у Robokassa (ASSUMPTION 3)
const SUCCESS_STATE_CODES = new Set([100]);

// ── Zod-схема ответа ──────────────────────────────────────────────────────

const RobokassaOperationSchema = z.object({
  InvId: z.union([z.string(), z.number()]).transform(String),
  OutSum: z.string(),
  // StateCode: числовой код статуса операции
  StateCode: z.number(),
  // Дата и описание могут отсутствовать в части форматов
  RequestDate: z.string().optional(),
  StateDate: z.string().optional(),
  Description: z.string().optional(),
});

const RobokassaResponseSchema = z.object({
  Result: z.object({
    Code: z.number(),
  }),
  Items: z.array(RobokassaOperationSchema).default([]),
});

// ── Вспомогательные функции ───────────────────────────────────────────────

/**
 * Генерирует MD5-подпись для Robokassa.
 * ASSUMPTION 2: SignatureValue = md5(MerchantLogin:StartDate:EndDate:Password2)
 */
function buildSignature(
  merchantLogin: string,
  startDate: string,
  endDate: string,
  password: string
): string {
  const str = `${merchantLogin}:${startDate}:${endDate}:${password}`;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/** Преобразует YYYY-MM-DD в "DD.MM.YYYY 00:00:00" (формат Robokassa). */
function toRobokassaDate(iso: string, time: '00:00:00' | '23:59:59' = '00:00:00'): string {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}.${mm}.${yyyy} ${time}`;
}

/**
 * Парсит дату из Robokassa ("DD.MM.YYYY HH:mm:ss") в YYYY-MM-DD.
 * Если формат неизвестен — возвращает сегодняшнюю дату (safe fallback).
 */
function parseRobokassaDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const match = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(raw.trim());
  if (match) {
    const [, dd, mm, yyyy] = match;
    return `${yyyy}-${mm}-${dd}`;
  }
  return new Date().toISOString().slice(0, 10);
}

/** "1500.50" → 150050n копеек */
function parseRubToKopecks(raw: string): bigint {
  const num = parseFloat(raw.replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return 0n;
  return BigInt(Math.round(num * 100));
}

// ── Маппинг описание → направление ───────────────────────────────────────

/**
 * Определяет direction_id и entity_id по описанию операции,
 * используя правила из prodamus_product_mapping (те же, что у Prodamus CSV).
 */
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
      return {
        directionId: m.directionId,
        entityId: m.entityId,
        categoryId: m.categoryId,
      };
    }
  }
  return { directionId: null, entityId: null, categoryId: null };
}

// ── Запрос к API ─────────────────────────────────────────────────────────

async function fetchOperations(
  merchantLogin: string,
  password: string,
  sinceDate: string
): Promise<RawSourceTransaction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = toRobokassaDate(sinceDate, '00:00:00');
  const endDate = toRobokassaDate(today, '23:59:59');
  const signature = buildSignature(merchantLogin, startDate, endDate, password);

  const params = new URLSearchParams({
    MerchantLogin: merchantLogin,
    StartDate: startDate,
    EndDate: endDate,
    SignatureValue: signature,
  });

  const url = `${ROBOKASSA_BASE_URL}${ROBOKASSA_OPERATION_LIST_PATH}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let responseBody: string;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    // 401/403 → credentials invalid, пробрасываем с явным кодом
    if (res.status === 401 || res.status === 403) {
      throw new CredentialsError(`Robokassa responded with HTTP ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(`Robokassa HTTP ${res.status}`);
    }

    responseBody = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(responseBody);
  } catch {
    throw new Error('Robokassa: failed to parse JSON response');
  }

  const parsed = RobokassaResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Robokassa: unexpected response schema — ${parsed.error.message}`);
  }

  if (parsed.data.Result.Code !== 0) {
    throw new Error(`Robokassa API error code=${parsed.data.Result.Code}`);
  }

  const mappings = await getActiveProdamusMappings();

  const result: RawSourceTransaction[] = [];
  for (const item of parsed.data.Items) {
    if (!SUCCESS_STATE_CODES.has(item.StateCode)) continue;

    const amount = parseRubToKopecks(item.OutSum);
    if (amount <= 0n) continue;

    const description = item.Description ?? null;
    const occurredAt = parseRobokassaDate(item.RequestDate ?? item.StateDate);

    // Пытаемся определить направление по описанию через правила маппинга
    const mapping = description ? matchMapping(description, mappings) : null;

    result.push({
      externalId: `robokassa_${item.InvId}`,
      occurredAt,
      amount,
      currency: 'RUB',
      description,
      rawPayload: {
        invId: item.InvId,
        stateCode: item.StateCode,
        requestDate: item.RequestDate,
        // Результат маппинга — может быть использован при grouping в sync.ts
        directionId: mapping?.directionId ?? null,
        entityId: mapping?.entityId ?? null,
        categoryId: mapping?.categoryId ?? null,
        // НЕ включаем OutSum и customer data
      },
    });
  }

  return result;
}

// ── CredentialsError ──────────────────────────────────────────────────────

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

// ── SourceSyncer implementation ───────────────────────────────────────────

export const robokassaSyncer: SourceSyncer = {
  code: 'robokassa',

  async sync(sinceDate: string): Promise<SyncResult> {
    const merchantLogin = config.ROBOKASSA_MERCHANT_LOGIN;
    const password = config.ROBOKASSA_PASSWORD;

    if (!merchantLogin || !password) {
      log.warn({ source: 'robokassa' }, 'robokassa_credentials_missing');
      return { fetched: 0, inserted: 0 };
    }

    const raw = await fetchOperations(merchantLogin, password, sinceDate);
    log.info({ source: 'robokassa', fetched: raw.length }, 'robokassa_fetched');

    if (raw.length === 0) return { fetched: 0, inserted: 0 };

    // Резолвим entity_id из sources.entity_id для Robokassa (ip_eremyan)
    const entityRows = await sql<{ entity_id: string | null }[]>`
      SELECT entity_id FROM sources WHERE code = 'robokassa' LIMIT 1
    `;
    const entityId = entityRows[0]?.entity_id;
    if (!entityId) {
      log.warn({ source: 'robokassa' }, 'robokassa_entity_id_missing');
      return { fetched: raw.length, inserted: 0 };
    }

    // created_by — owner пользователь
    const users = await getAllActiveUsers();
    const owner = users.find((u) => u.role === 'owner');
    if (!owner) {
      log.warn({ source: 'robokassa' }, 'robokassa_no_owner_user');
      return { fetched: raw.length, inserted: 0 };
    }

    // direction/category определяются per-transaction через маппинг,
    // но insertSyncTransactions принимает один directionId для всей пачки.
    // Для Robokassa оставляем null (needs_classification=true), это ок.
    const inserted = await insertSyncTransactions({
      sourceCode: 'robokassa',
      transactions: raw,
      createdBy: owner.id,
      entityId,
      directionId: null,
      categoryId: null,
      flowType: 'income',
    });

    return { fetched: raw.length, inserted };
  },
};
