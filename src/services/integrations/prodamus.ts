import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import type { RawSourceTransaction } from './types.js';
import { insertSyncTransactions } from '../../db/repositories/integrations.js';
import { sql } from '../../db/client.js';

/** UUID ИП Карина Еремян (все приходы Продамуса — на ИП). */
const ENTITY_IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';

/**
 * Маршрут продажи Продамуса по названию продукта.
 *
 * ВАЖНО (уточнение бухгалтерии, 23.06.2026): Продамус — эквайринг ИП Еремян,
 * ВСЕ выплаты Продамуса падают на счёт ИП независимо от продукта. Поэтому
 * entityId ВСЕГДА = ИП. ООО получает доход только напрямую в Точку (счёт 40702).
 * Название продукта используем лишь для категории-направления (курс/клуб),
 * чтобы видеть разбивку в аналитике — но НЕ для смены юрлица/налоговой базы.
 */
function routeProdamusProduct(name: string): { entityId: string; categoryCode: string } {
  const t = name.toLowerCase();
  const categoryCode = /курс/.test(t) && /психолог/.test(t) ? 'prodamus_course' : 'prodamus_club';
  return { entityId: ENTITY_IP, categoryCode };
}

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
  // Комиссия эквайринга Продамуса. sum — ВАЛОВАЯ сумма заказа (то, что заплатил
  // клиент). commission — процент, commission_sum — сумма комиссии в рублях.
  // Бухгалтерия: доход = sum (валовый, для расчёта ЗП продавцам), а comission_sum
  // проводим отдельным расходом 'payment_commission', чтобы видеть уплаченную комиссию.
  commission: z.union([z.string(), z.number()]).transform(String).optional(),
  commission_sum: z.union([z.string(), z.number()]).transform(String).optional(),
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
 * Разбирает ключ form-поля с квадратными скобками в путь сегментов.
 * "products[0][name]" → ["products", "0", "name"].
 */
function parseKeyPath(key: string): string[] {
  const path: string[] = [];
  const head = key.indexOf('[');
  if (head === -1) return [key];
  path.push(key.slice(0, head));
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(key)) !== null) path.push(m[1] ?? '');
  return path;
}

/**
 * Превращает объект с плоскими скобочными ключами (как их отдаёт парсер тела
 * Vercel: `products[0][name]`) во ВЛОЖЕННУЮ структуру — такую же, какую PHP
 * формирует в $_POST и над которой Prodamus считает подпись. Узлы с ключами
 * 0..n-1 нормализуются в массивы (как PHP «список» → JSON-массив).
 *
 * Это КЛЮЧЕВОЙ момент: без реконструкции подпись считается над плоскими
 * ключами и НИКОГДА не совпадает с подписью Prodamus (вложенной) → вечный 400.
 */
export function unflattenFields(flat: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(flat)) {
    const segs = parseKeyPath(rawKey);
    let node: Record<string, unknown> = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] ?? '';
      if (i === segs.length - 1) {
        node[seg] = value;
      } else {
        const next = node[seg];
        if (next === null || typeof next !== 'object') node[seg] = {};
        node = node[seg] as Record<string, unknown>;
      }
    }
  }
  return normalizeArrays(root) as Record<string, unknown>;
}

/** Рекурсивно: объект с ключами «0..n-1» → массив (как PHP список). */
function normalizeArrays(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const isList =
    keys.length > 0 && keys.every((k, i) => k === String(i));
  if (isList) return keys.map((k) => normalizeArrays(obj[k]));
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = normalizeArrays(obj[k]);
  return out;
}

/**
 * Проверяет подпись Prodamus из заголовка Sign.
 *
 * Устойчиво к тому, как тело пришло: сверяем подпись и над ВЛОЖЕННОЙ
 * реконструкцией (как считает Prodamus), и над исходными плоскими полями
 * (на случай, если парсер уже отдал вложенную структуру или формат изменится).
 * Обе ветки требуют секрет — безопасность сохраняется.
 */
export function verifyProdamusSignature(
  fields: Record<string, unknown>,
  signHeader: string,
  secretKey: string
): boolean {
  const want = signHeader.toLowerCase();
  const candidates = [unflattenFields(fields), fields];
  return candidates.some((c) => computeProdamusSignature(c, secretKey).toLowerCase() === want);
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
    // Диагностика без утечки секрета: какие ключи пришли + первые символы
    // ожидаемой подписи — чтобы быстро понять причину по логам Vercel.
    log.warn(
      {
        source: 'prodamus',
        signature_ok: false,
        keys: Object.keys(rawFields).slice(0, 30),
        sign_recv_prefix: signHeader.slice(0, 10),
        sign_calc_prefix: computeProdamusSignature(unflattenFields(rawFields), secretKey).slice(0, 10),
      },
      'prodamus_webhook_bad_signature'
    );
    return { ok: false, status: 400, responseBody: 'bad sign' };
  }

  log.info({ source: 'prodamus', signature_ok: true }, 'prodamus_webhook_signature_ok');

  // Демо/тестовый пинг Продамуса. При добавлении URL в кабинете (и кнопкой
  // «протестировать») Продамус шлёт подписанный демо-платёж (demo_mode=1). Если
  // ответить ошибкой — Продамус считает адрес нерабочим и НЕ сохраняет его
  // («слетает»). Поэтому: подпись валидна → отвечаем 200 success, но НЕ создаём
  // операцию (иначе в учёт попадёт фейковый демо-платёж).
  const demoRaw = String(
    (rawFields as Record<string, unknown>)['demo_mode'] ??
      (rawFields as Record<string, unknown>)['demo'] ??
      ''
  ).trim().toLowerCase();
  if (demoRaw === '1' || demoRaw === 'true' || demoRaw === 'yes') {
    log.info({ source: 'prodamus' }, 'prodamus_webhook_demo_ping_ok');
    return { ok: true, status: 200, responseBody: 'success' };
  }

  // Zod-валидация payload по ВЛОЖЕННОЙ структуре (products как настоящий массив,
  // иначе товар не распознаётся и маршрут по продукту падает в дефолт).
  const nested = unflattenFields(rawFields);
  const parsed = ProdamusWebhookSchema.safeParse(nested);
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

  // Маршрут по продукту: курс ДПО → ООО / prodamus_course; клуб → ИП / prodamus_club
  const route = routeProdamusProduct(productName);
  const catRows = await sql<{ id: string }[]>`
    SELECT id FROM categories WHERE code = ${route.categoryCode} AND deleted_at IS NULL LIMIT 1
  `;
  const categoryId = catRows[0]?.id ?? null;
  const entityId = route.entityId;

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
      entityId,
      categoryId,
      // НЕ включаем customer_email, customer_phone, sum
    },
    needsClassification: false,
  };

  // created_by = OWNER_TG_ID (bigint) — реальная схема БД (transactions.created_by BIGINT)
  const createdBy: bigint = config.OWNER_TG_ID;

  const inserted = await insertSyncTransactions({
    sourceCode: 'prodamus',
    transactions: [tx],
    createdBy,
    entityId,
    directionId: null,
    categoryId,
    flowType: 'income',
    // Деньги «в пути»: продажа в Продамусе есть, но на счёт Точки ещё не пришла
    // (зачисление обычно на следующие сутки). Когда выплата Продамуса упадёт в
    // Точку — tochkaSync переведёт эти операции в 'completed'.
    txStatus: 'pending',
  });

  // ── Комиссия эквайринга Продамуса — отдельный расход ────────────────────
  // Бухгалтерия (обратная связь 04.07.2026): доход зачисляем ВАЛОВЫЙ (sum),
  // а уплаченную комиссию проводим отдельным расходом 'payment_commission',
  // чтобы её было видно в P&L. Пример: продажа 5000 → доход 5000 + расход 155.
  let commissionInserted = 0;
  const commissionRaw = payload.commission_sum;
  if (commissionRaw !== undefined && commissionRaw !== '' && commissionRaw !== '0') {
    try {
      const commissionAmount = toKopecks(commissionRaw);
      if (commissionAmount > 0n) {
        const commTx: RawSourceTransaction = {
          externalId: `prodamus_comm_${payload.order_num ?? payload.order_id ?? externalId}`,
          occurredAt,
          amount: commissionAmount,
          currency,
          description: 'Комиссия Продамуса',
          rawPayload: {
            orderId: payload.order_id ?? null,
            orderNum: payload.order_num ?? null,
            commissionPercent: payload.commission ?? null,
            ofGross: payload.sum,
          },
          needsClassification: false,
        };
        commissionInserted = await insertSyncTransactions({
          sourceCode: 'prodamus',
          transactions: [commTx],
          createdBy,
          entityId,
          directionId: null,
          categoryId: null,
          flowType: 'expense',
          // Комиссия «в пути» вместе с валовым доходом: удержится в момент выплаты
          // Продамуса на Точку. tochkaSync переведёт её в 'completed' вместе с доходом.
          txStatus: 'pending',
          pnlCategory: 'payment_commission',
          counterparty: 'Комиссия Продамуса',
        });
      }
    } catch {
      log.warn({ source: 'prodamus' }, 'prodamus_webhook_commission_parse_failed');
    }
  }

  log.info(
    { source: 'prodamus', inserted, commissionInserted, products_count: payload.products.length },
    'prodamus_webhook_processed'
  );

  return { ok: true, status: 200, responseBody: 'success' };
}
