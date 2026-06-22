/**
 * Автосинхронизация Точки через JWT Bearer-токен (TOCHKA_JWT_TOKEN).
 *
 * Логика полностью соответствует рабочему скрипту scripts/sync_incremental.mjs:
 *   1. GET /accounts — список счетов; myNums для isOwn-фильтра.
 *   2. GET /accounts/{id}/balances — обновляем funds.balance по tochka_account_id
 *      (используем ClosingAvailable, как в скрипте).
 *   3. POST /statements + GET poll до Ready (cap 30 попыток × 2 с).
 *      GET-ответ: Data.Statement — МАССИВ; статус и операции из [0].
 *   4. Фильтруем isOwn (внутренние переводы → пропустить).
 *   5. INSERT ON CONFLICT DO NOTHING (external_id = 'tochka_' + transactionId).
 *      Доходы: isLoan → pnl_category='loan', Продамус/НКО → категория по паттерну.
 *      Расходы: pnl_category=NULL, needs_classification=true, needs_review=true.
 *   6. classifyTransactions — новые расходы с pnl_category IS NULL;
 *      UPDATE pnl_category/is_personal/classifier_confidence/needs_review.
 *      При сбое классификатора — не падать, операции остаются needs_review=true.
 *
 * Все запросы к БД ПОСЛЕДОВАТЕЛЬНО (pgBouncer transaction mode).
 * Логируются только метаданные (added/balancesUpdated/classified) — без текстов операций.
 */

import { z } from 'zod';
import { config } from '../../config.js';
import { sql } from '../../db/client.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import { classifyTransactions, type TxToClassify } from '../transactionClassifier.js';
import { fetchAndStoreFxRates } from '../cbr.js';

const log = childLogger({ handler: 'tochkaSync' });

// ── Константы ──────────────────────────────────────────────────────────────

const API_BASE = 'https://enter.tochka.com/uapi/open-banking/v1.0';
const MY_INN = '231149826704';

/** UUID ИП Карина Еремян (счета Точки с префиксом 40802). */
const ENTITY_IP_ID = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
/** UUID ООО Ассургина (счета Точки с префиксом 40702). */
const ENTITY_OOO_ID = 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d';
/** UUID направления ДПО (доходы ИП). */
const DIRECTION_DPO_ID = 'b17eb69e-4bd3-441f-8a0c-57734d56840c';
/** UUID направления Метанойя (доходы ООО). */
const DIRECTION_METANOIA_ID = 'ac773f21-0f0d-4772-8baf-15cac941c122';

/**
 * Доп-счёт ИП = карта Натальи Скрипниковой (её зарплата). Все ТРАТЫ с этой
 * карты учитываем как ФОТ (зарплата Наташи), без жёлтого флага. Сам счёт скрыт
 * из «Денег на ИП». Сравниваем по номеру счёта (без БИК).
 */
const NATASHA_CARD_ACCOUNT = '40802810420000644796';

/** ООО — счёт с префиксом 40702; иначе ИП. Возвращает entity+direction для дохода. */
function entityForAccount(accountId: string): { entityId: string; incomeDirectionId: string } {
  const num = accountId.split('/')[0] ?? '';
  return num.startsWith('40702')
    ? { entityId: ENTITY_OOO_ID, incomeDirectionId: DIRECTION_METANOIA_ID }
    : { entityId: ENTITY_IP_ID, incomeDirectionId: DIRECTION_DPO_ID };
}

const STATEMENT_POLL_MAX = 30;
const STATEMENT_POLL_INTERVAL_MS = 2000;

/** Окно синхронизации: 14 дней назад в МСК. */
const SYNC_DAYS_BACK = 14;

// ── Публичный результат ────────────────────────────────────────────────────

export interface SyncTochkaResult {
  added: number;
  balancesUpdated: number;
  classified: number;
  dateTo: string;
}

// ── Zod-схемы ─────────────────────────────────────────────────────────────

/**
 * Один счёт из GET /accounts.
 * Используем accountId и ИНН из AccountId (для isOwn-проверки).
 */
const AccountSchema = z.object({
  accountId: z.string(),
  // Точка: accountId = "<номер>/<БИК>" или просто "<номер>"
});

const AccountsResponseSchema = z.object({
  Data: z.object({
    Account: z.array(AccountSchema).default([]),
  }),
});

/**
 * Баланс счёта из GET /accounts/{id}/balances.
 * Используем ClosingAvailable (как в скрипте).
 */
const BalanceItemSchema = z.object({
  Amount: z.object({
    amount: z.union([z.string(), z.number()]),
    currency: z.string().default('RUB'),
  }),
  type: z.string(),
});

const BalancesResponseSchema = z.object({
  Data: z.object({
    Balance: z.array(BalanceItemSchema).default([]),
  }),
});

/** Сторона транзакции (контрагент). */
const PartySchema = z.object({
  name: z.string().optional(),
  inn: z.string().optional(),
}).optional();

/** Реквизиты счёта контрагента. */
const AccountIdentificationSchema = z.object({
  identification: z.string().optional(),
}).optional();

/**
 * Одна операция в выписке.
 * Поля соответствуют реальному ответу Точки (Open Banking UK),
 * сверено со скриптом sync_incremental.mjs.
 */
const TxSchema = z.object({
  transactionId: z.string(),
  creditDebitIndicator: z.enum(['Credit', 'Debit']),
  Amount: z.object({
    amount: z.union([z.string(), z.number()]),
    currency: z.string().default('RUB'),
  }).optional(),
  // documentProcessDate — поле Точки (есть в скрипте); bookingDateTime — запасной
  documentProcessDate: z.string().optional(),
  bookingDateTime: z.string().optional(),
  description: z.string().optional().nullable(),
  DebtorParty: PartySchema,
  CreditorParty: PartySchema,
  DebtorAccount: AccountIdentificationSchema,
  CreditorAccount: AccountIdentificationSchema,
  // Банк получателя/плательщика: identification = БИК (RU.CBR.BIK).
  CreditorAgent: AccountIdentificationSchema.optional(),
  DebtorAgent: AccountIdentificationSchema.optional(),
});

type TxItem = z.infer<typeof TxSchema>;

/**
 * GET /accounts/{id}/statements/{sid}.
 * Data.Statement — МАССИВ (как в скрипте). Берём [0].
 */
const StatementPollResponseSchema = z.object({
  Data: z.object({
    Statement: z.array(
      z.object({
        status: z.string(),
        Transaction: z.array(TxSchema).default([]),
      })
    ).default([]),
  }),
});

/** POST /statements response. */
const StatementInitResponseSchema = z.object({
  Data: z.object({
    Statement: z.union([
      // Точка возвращает объект с statementId
      z.object({ statementId: z.string(), status: z.string().optional() }),
      // На случай если массив
      z.array(z.object({ statementId: z.string(), status: z.string().optional() })),
    ]),
  }),
});

// ── Вспомогательные функции ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** МСК-дата (UTC+3) в формате YYYY-MM-DD. */
function mskDateString(offsetDays = 0): string {
  const ms = Date.now() + 3 * 3600_000 + offsetDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Проверяет, является ли транзакция внутренней (собственные средства).
 * Логика из скрипта: ИНН контрагента совпадает с MY_INN, или
 * назначение содержит «собственных средств», или номер счёта контрагента
 * входит в наш набор номеров (myNums).
 */
function isOwn(tx: TxItem, myNums: Set<string>): boolean {
  const isCredit = tx.creditDebitIndicator === 'Credit';
  const party = isCredit ? tx.DebtorParty : tx.CreditorParty;
  const accountPart = isCredit
    ? tx.DebtorAccount?.identification
    : tx.CreditorAccount?.identification;

  if (party?.inn === MY_INN) return true;
  if (/собственных средств/i.test(tx.description ?? '')) return true;

  const accNum = (accountPart ?? '').split('/')[0] ?? '';
  if (accNum.length > 0 && myNums.has(accNum)) return true;

  return false;
}

/** Проверяет, является ли контрагент «Фреш Кредит». */
function isLoan(name: string | null | undefined): boolean {
  return /фреш\s*кредит/i.test(name ?? '');
}

/** Возвращает номер счёта (часть до '/') из accountId. */
function accountNumber(accountId: string): string {
  return accountId.split('/')[0] ?? accountId;
}

// ── HTTP-обёртка ───────────────────────────────────────────────────────────

async function apiGet(path: string, token: string): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Tochka GET ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
}

async function apiPost(path: string, body: unknown, token: string): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Tochka POST ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
}

// ── Шаг 1: получить счета ─────────────────────────────────────────────────

async function fetchAccounts(token: string): Promise<string[]> {
  const raw = await apiGet('/accounts', token);
  const parsed = AccountsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Tochka accounts schema error: ${parsed.error.message}`);
  }
  return parsed.data.Data.Account.map((a) => a.accountId);
}

// ── Шаг 2: обновить баланс фонда ─────────────────────────────────────────

async function syncFundBalance(accountId: string, token: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await apiGet(`/accounts/${encodeURIComponent(accountId)}/balances`, token);
  } catch (err) {
    log.warn(
      { handler: 'tochkaSync', account_id: accountId, err: String(err) },
      'tochka_balance_fetch_failed'
    );
    return false;
  }

  const parsed = BalancesResponseSchema.safeParse(raw);
  if (!parsed.success) return false;

  const closingAvail = parsed.data.Data.Balance.find((b) => b.type === 'ClosingAvailable');
  if (closingAvail === undefined) return false;

  let kop: bigint;
  try {
    kop = toKopecks(closingAvail.Amount.amount);
  } catch {
    return false;
  }

  const updated = await sql<{ id: string }[]>`
    UPDATE funds
    SET balance = ${kop}
    WHERE tochka_account_id = ${accountId}
      AND deleted_at IS NULL
    RETURNING id
  `;

  return updated.length > 0;
}

// ── Шаг 3: выписка (init + poll) ─────────────────────────────────────────

async function fetchStatementTransactions(
  accountId: string,
  startDate: string,
  endDate: string,
  token: string
): Promise<TxItem[] | null> {
  // 3a. Инициировать выписку
  const initRaw = await apiPost(
    '/statements',
    {
      Data: {
        Statement: {
          accountId,
          startDateTime: startDate,
          endDateTime: endDate,
        },
      },
    },
    token
  );

  const initParsed = StatementInitResponseSchema.safeParse(initRaw);
  if (!initParsed.success) {
    throw new Error(`Tochka statement init schema error: ${initParsed.error.message}`);
  }

  const stmtData = initParsed.data.Data.Statement;
  const statementId = Array.isArray(stmtData)
    ? stmtData[0]?.statementId
    : stmtData.statementId;

  if (statementId === undefined) {
    throw new Error(`Tochka statement init: no statementId in response`);
  }

  log.info(
    { handler: 'tochkaSync', account_id: accountId, statement_id: statementId },
    'tochka_statement_initiated'
  );

  // 3b. Поллинг до статуса Ready
  const pollPath = `/accounts/${encodeURIComponent(accountId)}/statements/${encodeURIComponent(statementId)}`;

  for (let attempt = 0; attempt < STATEMENT_POLL_MAX; attempt++) {
    if (attempt > 0) {
      await sleep(STATEMENT_POLL_INTERVAL_MS);
    }

    const pollRaw = await apiGet(pollPath, token);
    const pollParsed = StatementPollResponseSchema.safeParse(pollRaw);
    if (!pollParsed.success) {
      throw new Error(`Tochka statement poll schema error: ${pollParsed.error.message}`);
    }

    const stmtArr = pollParsed.data.Data.Statement;
    const first = stmtArr[0];

    log.info(
      {
        handler: 'tochkaSync',
        account_id: accountId,
        attempt: attempt + 1,
        status: first?.status ?? 'unknown',
      },
      'tochka_statement_poll'
    );

    if (first?.status === 'Ready') {
      return first.Transaction;
    }
  }

  log.warn(
    { handler: 'tochkaSync', account_id: accountId, max_attempts: STATEMENT_POLL_MAX },
    'tochka_statement_not_ready'
  );
  return null; // выписка не готова — пропускаем счёт
}

// ── Шаг 4+5: вставка операций ─────────────────────────────────────────────

/** Результат вставки одной операции. */
interface InsertResult {
  id: string;
  flowType: 'income' | 'expense';
  wasInserted: boolean;
}

async function insertTransaction(
  tx: TxItem,
  today: string,
  sourceId: string,
  createdBy: bigint,
  accountId: string
): Promise<InsertResult> {
  const isCredit = tx.creditDebitIndicator === 'Credit';
  const flowType: 'income' | 'expense' = isCredit ? 'income' : 'expense';
  // Юрлицо и направление определяем по счёту: 40702 → ООО/Метанойя, иначе ИП/ДПО.
  const { entityId, incomeDirectionId } = entityForAccount(accountId);

  // Сумма
  const rubStr = tx.Amount?.amount ?? '0';
  const rub = Number(rubStr);
  if (!(rub > 0)) {
    return { id: '', flowType, wasInserted: false };
  }
  const kop = BigInt(Math.round(rub * 100));

  // Дата: documentProcessDate из поля Точки, иначе bookingDateTime, иначе today
  const dateRaw = tx.documentProcessDate ?? tx.bookingDateTime;
  const occurredAt = dateRaw
    ? (dateRaw.length >= 10 ? dateRaw.slice(0, 10) : today)
    : today;
  const occTs = `${occurredAt}T12:00:00Z`;

  // Контрагент
  const who = ((isCredit ? tx.DebtorParty?.name : tx.CreditorParty?.name) ?? '').slice(0, 200);
  const desc = (tx.description ?? '').slice(0, 300);
  const externalId = `tochka_${tx.transactionId}`;

  // Категория дохода и pnl_category (логика из скрипта)
  let pnlCategory: string | null = null;
  let catCode: string;
  let needsClassification: boolean;
  let needsReview: boolean;

  if (isCredit) {
    const loan = isLoan(who);
    if (loan) {
      pnlCategory = 'loan';
      catCode = 'other_income';
    } else if (/продамус/i.test(who)) {
      catCode = 'prodamus_course';
    } else if (/платежи и расч/i.test(who)) {
      catCode = 'prodamus_club';
    } else {
      catCode = 'other_income';
    }
    needsClassification = false;
    needsReview = false;
  } else {
    // Расход: pnl_category будет назначена классификатором после вставки
    catCode = 'other_expense';
    pnlCategory = null;
    needsClassification = true;
    needsReview = true;
  }

  // Траты с карты Наташи (доп-счёт ИП) → ФОТ (зарплата Наташи), без жёлтого.
  let counterpartyOut = who;
  let descOut = desc;
  if (!isCredit && accountId.split('/')[0] === NATASHA_CARD_ACCOUNT) {
    pnlCategory = 'payroll';
    needsClassification = false;
    needsReview = false;
    counterpartyOut = 'Наташа Скрипникова (ЗП)';
    descOut = ('Наташа Скрипникова (ЗП)' + (desc ? ' · ' + desc : '')).slice(0, 300);
  }

  // Резолвим category_id по коду (ПОСЛЕДОВАТЕЛЬНО)
  const catRows = await sql<{ id: string }[]>`
    SELECT id FROM categories WHERE code = ${catCode} LIMIT 1
  `;
  const categoryId = catRows[0]?.id ?? null;

  // direction_id: для доходов — направление юрлица, для расходов — null
  const directionId: string | null = isCredit ? incomeDirectionId : null;

  const rows = await sql<{ id: string }[]>`
    INSERT INTO transactions (
      flow_type, amount, currency, amount_rub, fx_rate,
      entity_id, direction_id, category_id, source_id,
      occurred_at, description, counterparty, pnl_category,
      external_id, created_by,
      verified, needs_classification, needs_review, needs_owner_review
    ) VALUES (
      ${flowType},
      ${kop},
      'RUB',
      ${kop},
      NULL,
      ${entityId},
      ${directionId},
      ${categoryId},
      ${sourceId},
      ${occTs},
      ${descOut || null},
      ${counterpartyOut || null},
      ${pnlCategory},
      ${externalId},
      ${createdBy},
      false,
      ${needsClassification},
      ${needsReview},
      false
    )
    ON CONFLICT (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
    RETURNING id
  `;

  const inserted = rows[0] !== undefined;
  const id = rows[0]?.id ?? '';
  return { id, flowType, wasInserted: inserted };
}

// ── Шаг 6: классификация расходов ─────────────────────────────────────────

/**
 * Выбирает новые расходы без pnl_category за период и прогоняет через
 * classifyTransactions. Обновляет pnl_category, is_personal,
 * classifier_confidence, needs_review.
 * Никогда не бросает — при сбое классификатора возвращает 0.
 */
async function classifyNewExpenses(
  startDate: string,
  endDate: string
): Promise<number> {
  // Выбираем расходы с pnl_category IS NULL за период (ПОСЛЕДОВАТЕЛЬНО)
  const rows = await sql<{
    id: string;
    counterparty: string | null;
    amount_rub: bigint;
    description: string | null;
  }[]>`
    SELECT id, counterparty, amount_rub, description
    FROM transactions
    WHERE flow_type = 'expense'
      AND pnl_category IS NULL
      AND deleted_at IS NULL
      AND occurred_at >= ${startDate}
      AND occurred_at <= ${endDate}
  `;

  if (rows.length === 0) return 0;

  const toClassify: TxToClassify[] = rows.map((r) => ({
    id: r.id,
    counterparty: r.counterparty,
    amount: Number(r.amount_rub),
    description: r.description,
    inn: null,
    flowType: 'expense' as const,
  }));

  let results;
  try {
    results = await classifyTransactions(toClassify);
  } catch (err) {
    log.warn(
      { handler: 'tochkaSync', count: toClassify.length, err: String(err) },
      'tochka_classify_failed'
    );
    return 0;
  }

  let classified = 0;
  for (const r of results) {
    if (r.pnlCategory === 'other_business' && r.confidence === 0) {
      // fallback — оставляем needs_review=true, не считаем за «классифицированную»
      continue;
    }
    // Обновляем ПОСЛЕДОВАТЕЛЬНО
    await sql`
      UPDATE transactions
      SET pnl_category         = ${r.pnlCategory},
          is_personal          = ${r.isPersonal},
          classifier_confidence = ${r.confidence},
          needs_review         = ${r.confidence < 0.7}
      WHERE id = ${r.id}
        AND deleted_at IS NULL
    `;
    classified++;
  }

  log.info(
    { handler: 'tochkaSync', total: rows.length, classified },
    'tochka_classify_done'
  );

  return classified;
}

// ── Валидация входа (публичная функция) ───────────────────────────────────

const SyncTochkaInputSchema = z.object({}).optional();

// ── Главная экспортируемая функция ─────────────────────────────────────────

/**
 * Синхронизирует транзакции Точки за последние 14 дней.
 *
 * @throws Error если TOCHKA_JWT_TOKEN не задан.
 *
 * @returns {SyncTochkaResult} Сводка: добавлено операций, обновлено балансов фондов,
 *   классифицировано расходов, дата до которой синхронизировали.
 */
export async function syncTochka(
  _input?: z.input<typeof SyncTochkaInputSchema>
): Promise<SyncTochkaResult> {
  // Zod-валидация входа (нет обязательных параметров, но паттерн обязателен)
  SyncTochkaInputSchema.parse(_input);

  const token = config.TOCHKA_JWT_TOKEN;
  if (!token) {
    throw new Error('TOCHKA_JWT_TOKEN не настроен');
  }

  const createdBy: bigint = config.OWNER_TG_ID;

  // Флаг: в этом синке пришла выплата от Продамуса → деньги «в пути» дошли.
  let prodamusPayoutSeen = false;

  // Даты окна синхронизации в МСК
  const today = mskDateString(0);
  const startDate = mskDateString(-SYNC_DAYS_BACK);

  log.info(
    { handler: 'tochkaSync', start_date: startDate, end_date: today },
    'tochka_sync_start'
  );

  // Обновляем курсы валют ЦБ РФ (для конвертации валютных доходов Lava: USD/EUR).
  // Не фатально: при сбое ЦБ продолжаем синк (используются последние известные курсы).
  try {
    await fetchAndStoreFxRates();
  } catch (err) {
    log.warn({ handler: 'tochkaSync', err: String(err) }, 'tochka_fx_refresh_failed');
  }

  // Резолвим source_id по коду 'tochka' ОДИН РАЗ
  const srcRows = await sql<{ id: string }[]>`
    SELECT id FROM sources WHERE code = 'tochka' LIMIT 1
  `;
  const sourceId = srcRows[0]?.id;
  if (sourceId === undefined) {
    throw new Error('Источник "tochka" не найден в таблице sources');
  }

  // Шаг 1: счета
  const accountIds = await fetchAccounts(token);
  if (accountIds.length === 0) {
    log.warn({ handler: 'tochkaSync' }, 'tochka_no_accounts');
    return { added: 0, balancesUpdated: 0, classified: 0, dateTo: today };
  }

  // Множество номеров счетов для isOwn-проверки (только числовая часть до '/')
  const myNums = new Set(accountIds.map(accountNumber));

  let added = 0;
  let balancesUpdated = 0;

  // Обрабатываем каждый счёт ПОСЛЕДОВАТЕЛЬНО
  for (const accountId of accountIds) {
    // Шаг 2: баланс фонда
    const balUpdated = await syncFundBalance(accountId, token);
    if (balUpdated) balancesUpdated++;

    // Шаг 3: выписка
    let txItems: TxItem[] | null;
    try {
      txItems = await fetchStatementTransactions(
        accountId,
        startDate,
        today,
        token
      );
    } catch (err) {
      log.warn(
        { handler: 'tochkaSync', account_id: accountId, err: String(err) },
        'tochka_statement_error'
      );
      continue;
    }

    if (txItems === null) {
      // Выписка не готова — пропускаем счёт
      continue;
    }

    // Шаги 4+5: фильтрация и вставка
    for (const tx of txItems) {
      // Пропускаем внутренние переводы
      if (isOwn(tx, myNums)) continue;

      // Пропускаем ЗАЧИСЛЕНИЯ от Продамуса: доход Продамуса учитывается
      // по каждой продаже (вебхук/выгрузка) с разбивкой ДПО→ООО / клуб→ИП.
      // Банковское зачисление — это выплата уже учтённых продаж (иначе двойной счёт).
      // НО факт прихода выплаты = деньги «в пути» дошли → потом переведём их в completed.
      if (tx.creditDebitIndicator === 'Credit' && /продамус/i.test(tx.DebtorParty?.name ?? '')) {
        prodamusPayoutSeen = true;
        continue;
      }

      // Проверяем, что сумма положительная (как в скрипте)
      const rubStr = tx.Amount?.amount ?? '0';
      const rub = Number(rubStr);
      if (!(rub > 0)) continue;

      let result: InsertResult;
      try {
        result = await insertTransaction(tx, today, sourceId, createdBy, accountId);
      } catch (err) {
        log.warn(
          { handler: 'tochkaSync', tx_id: tx.transactionId, err: String(err) },
          'tochka_tx_insert_error'
        );
        continue;
      }

      if (result.wasInserted) {
        added++;
      }
    }
  }

  // Деньги в пути: если пришла выплата Продамуса — продажи прошлых дней дошли.
  // Переводим pending-доход Продамуса с occurred_at < сегодня в completed.
  // Сегодняшние продажи остаются «в пути» (зачисление обычно на следующие сутки).
  if (prodamusPayoutSeen) {
    try {
      const flipped = await sql<{ id: string }[]>`
        UPDATE transactions
        SET tx_status = 'completed', updated_at = NOW()
        WHERE deleted_at IS NULL
          AND flow_type = 'income'
          AND tx_status = 'pending'
          AND source_id = (SELECT id FROM sources WHERE code = 'prodamus')
          AND occurred_at < ${today}
        RETURNING id
      `;
      log.info({ handler: 'tochkaSync', flipped: flipped.length }, 'prodamus_in_transit_settled');
    } catch (err) {
      log.warn({ handler: 'tochkaSync', err: String(err) }, 'prodamus_settle_failed');
    }
  }

  // Шаг 6: классификация новых расходов
  let classified = 0;
  try {
    classified = await classifyNewExpenses(startDate, today);
  } catch (err) {
    // classifyNewExpenses сам не бросает, но на всякий случай
    log.warn(
      { handler: 'tochkaSync', err: String(err) },
      'tochka_classify_outer_error'
    );
  }

  log.info(
    { handler: 'tochkaSync', added, balancesUpdated, classified, dateTo: today },
    'tochka_sync_done'
  );

  return { added, balancesUpdated, classified, dateTo: today };
}

// ── Поиск реквизитов контрагента по выписке Точки ──────────────────────────

export interface CounterpartyRequisites {
  name: string;
  inn: string | null;
  account: string | null; // 20-значный р/с
  bik: string | null;      // 9-значный БИК
}

/**
 * Ищет реквизиты получателя по его прошлым ИСХОДЯЩИМ платежам в выписке Точки
 * (Debit → CreditorParty/CreditorAccount). Возвращает полное имя, ИНН, р/с, БИК.
 * Берёт первый счёт, где нашёлся платёж с полными реквизитами (быстрее, чем
 * сканировать все 9 счетов). Окно — 90 дней. null, если не найден.
 */
export async function fetchCounterpartyRequisites(
  namePattern: string
): Promise<CounterpartyRequisites | null> {
  const token = config.TOCHKA_JWT_TOKEN;
  if (!token) return null;
  const pat = namePattern.trim().toLowerCase();
  if (pat.length < 3) return null;

  let accounts: string[];
  try {
    accounts = await fetchAccounts(token);
  } catch {
    return null;
  }
  const start = mskDateString(-90);
  const end = mskDateString(0);

  for (const acc of accounts) {
    let txs: TxItem[] | null = null;
    try {
      txs = await fetchStatementTransactions(acc, start, end, token);
    } catch {
      continue;
    }
    if (!txs) continue;

    // Перебираем от свежих к старым (выписка обычно по возрастанию даты — берём
    // последнее совпадение).
    let match: TxItem | null = null;
    for (const tx of txs) {
      if (tx.creditDebitIndicator !== 'Debit') continue;
      const nm = (tx.CreditorParty?.name ?? '').toLowerCase();
      if (nm.includes(pat)) match = tx; // перезаписываем — останется самое позднее
    }
    if (match === null) continue;

    // Счёт получателя — CreditorAccount.identification; БИК — CreditorAgent.identification.
    const account = (match.CreditorAccount?.identification ?? '').split('/')[0] ?? '';
    const bik = (match.CreditorAgent?.identification ?? '').split('/')[0] ?? '';
    if (account.length >= 18 && bik.length === 9) {
      return {
        name: match.CreditorParty?.name ?? namePattern,
        inn: match.CreditorParty?.inn ?? null,
        account,
        bik,
      };
    }
  }
  return null;
}
