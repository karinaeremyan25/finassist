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
 *
 * Реальная схема БД:
 *   transactions.created_by = BIGINT (telegram_id из config.OWNER_TG_ID)
 *   entity_id = UUID (entities.code = 'IP', tax_type = usn_6)
 *   source_id = UUID (sources.code = 'robokassa')
 *   category_id = UUID (categories.code = 'prodamus_course' или по маппингу)
 *   direction_id = UUID (directions.code = 'DPO' по умолчанию)
 */

const log = childLogger({ handler: 'webhook:robokassa' });

// ── Константы (реальные UUID из БД) ──────────────────────────────────────
// Приоритет: сначала из БД по коду (динамически), константы — fallback.

/** Entity ИП Еремян (УСН 6%) — для Robokassa доходов ИП. */
const ENTITY_IP_ID = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
/** Direction ДПО — курс по умолчанию для Robokassa. */
const DIRECTION_DPO_ID = 'b17eb69e-4bd3-441f-8a0c-57734d56840c';
/** Category prodamus_course — онлайн-оплаты курса через Robokassa. */
const CATEGORY_PRODAMUS_COURSE_ID = '783d4aa6-0a57-478f-93bf-ea5ad89e8f62';

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

// ── Маппинг описание → направление (из prodamus_product_mapping) ──────────

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

// ── Резолвинг entity_id для robokassa из БД ───────────────────────────────

/**
 * Ищет entity_id для ИП в БД по коду 'IP'.
 * ASSUMPTION: реальная схема entities.code = 'IP' (не 'ip_eremyan').
 * Если не найдёт по 'IP' — пробует 'ip_eremyan', затем fallback на константу.
 */
async function resolveEntityId(): Promise<string> {
  // ASSUMPTION: код может быть 'IP' или 'ip_eremyan' — пробуем оба
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM entities
    WHERE code IN ('IP', 'ip_eremyan')
    LIMIT 1
  `;
  return rows[0]?.id ?? ENTITY_IP_ID;
}

/**
 * Ищет direction_id для DPO в БД по коду 'DPO'.
 * ASSUMPTION: реальная схема directions.code = 'DPO' (не 'course_dpo').
 */
async function resolveDirectionDpoId(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM directions
    WHERE code IN ('DPO', 'course_dpo')
    LIMIT 1
  `;
  return rows[0]?.id ?? DIRECTION_DPO_ID;
}

/**
 * Ищет category_id для prodamus_course в БД.
 */
async function resolveCategoryProdamoCourseId(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM categories
    WHERE code = 'prodamus_course'
    LIMIT 1
  `;
  return rows[0]?.id ?? CATEGORY_PRODAMUS_COURSE_ID;
}

// ── Обработчик webhook ────────────────────────────────────────────────────

/**
 * Обрабатывает входящий Robokassa ResultURL webhook.
 * Проверяет подпись, вставляет транзакцию.
 * Возвращает тело и статус ответа.
 *
 * created_by = config.OWNER_TG_ID (bigint) — реальная схема БД.
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

  // Дата = сегодня UTC
  const occurredAt = new Date().toISOString().slice(0, 10);

  // Описание из InvId (без персональных данных — EMail в лог не пишем)
  const description = `Robokassa InvId=${InvId}`;

  // Маппинг через продуктовые правила (по описанию попробуем сматчить)
  const mappings = await getActiveProdamusMappings();
  const mapping = matchMapping(description, mappings);

  // Резолвинг entity_id / direction_id / category_id (ПОСЛЕДОВАТЕЛЬНО — pgBouncer)
  const entityId = mapping.entityId ?? (await resolveEntityId());
  const directionId = mapping.directionId ?? (await resolveDirectionDpoId());
  const categoryId = mapping.categoryId ?? (await resolveCategoryProdamoCourseId());

  // created_by = OWNER_TG_ID (bigint) — реальная схема БД
  const createdBy: bigint = config.OWNER_TG_ID;

  const tx: RawSourceTransaction = {
    externalId: `robokassa_${InvId}`,
    occurredAt,
    amount,
    currency: 'RUB',
    description,
    rawPayload: {
      invId: InvId,
      paymentMethod: parsed.data.PaymentMethod ?? null,
      // НЕ включаем OutSum, EMail, Fee — персональные/финансовые данные
    },
  };

  const inserted = await insertSyncTransactions({
    sourceCode: 'robokassa',
    transactions: [tx],
    createdBy,
    entityId,
    directionId,
    categoryId,
    flowType: 'income',
  });

  log.info({ source: 'robokassa', inserted }, 'robokassa_webhook_processed');

  // Robokassa ждёт ответа "OK${InvId}" как text/plain
  return { ok: true, status: 200, responseBody: `OK${InvId}` };
}
