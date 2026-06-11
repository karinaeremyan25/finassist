import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import type { SourceSyncer, SyncResult, RawSourceTransaction } from './types.js';
import { insertSyncTransactions } from '../../db/repositories/integrations.js';
import { getSetting, setSetting } from '../../db/repositories/settings.js';
import { sql } from '../../db/client.js';

/**
 * Точка Банк — pull-синхронизатор (authorization_code flow).
 *
 * OAuth-флоу:
 *   1. Пользователь проходит consent → Точка редиректит на TOCHKA_REDIRECT_URI с ?code=...
 *   2. GET /api/tochka/callback → меняет code на tokens, сохраняет refresh_token в settings.
 *   3. При каждом syncTochka(): получаем access_token через refresh grant.
 *   4. Получаем список счетов, для каждого — выписку (statement flow).
 *   5. Операции маппим в transactions (income/expense).
 *   6. Балансы счетов-копилок (tochka_account_id) → funds.balance (ПОСЛЕДОВАТЕЛЬНО).
 *
 * ────────── ASSUMPTIONS (требуют сверки на реальном API) ──────────────────
 *
 * ASSUMPTION A — имена полей Transaction (Open Banking UK, Точка следует стандарту):
 *   transactionId, amount.amount (строка), amount.currency, creditDebitIndicator
 *   ('Credit'/'Debit'), bookingDateTime (ISO 8601),
 *   transactionInformation / remittanceInformationUnstructured (назначение),
 *   status ('Booked'/'Pending').
 *   Возможные альтернативы Точки: DocumentProductDateTime, operationDescription —
 *   сверить по реальному ответу.
 *
 * ASSUMPTION B — statement flow:
 *   POST /uapi/open-banking/v1.0/statements → { Data: { Statement: { statementId, status } } }
 *   GET  /uapi/open-banking/v1.0/accounts/{id}/statements/{sid}
 *        → { Data: { Statement: { status, Transaction: [] } } }
 *   Статусы: Created → Processing → Ready. До 5 попыток с паузой 3s.
 *
 * ASSUMPTION C — accounts response:
 *   GET /uapi/open-banking/v1.0/accounts
 *   → { Data: { Account: [{ accountId, currency, accountSubType, Balance: [{ Amount: { Amount, Currency } }] }] } }
 *   Тип копилки (сберегательный/накопительный счёт): accountSubType 'Savings' или 'CurrentAccount'.
 *   Balance.Amount.Amount — текущий баланс счёта (строка, рубли).
 *
 * ASSUMPTION D — token exchange (authorization_code):
 *   POST https://enter.tochka.com/connect/token
 *   Body (form-urlencoded): grant_type=authorization_code, code=..., redirect_uri=...,
 *   client_id=..., client_secret=...
 *   Response: { access_token, refresh_token, expires_in, token_type }
 *
 * ASSUMPTION E — token refresh:
 *   POST https://enter.tochka.com/connect/token
 *   Body: grant_type=refresh_token, refresh_token=..., client_id=..., client_secret=...
 *   Response: { access_token, refresh_token?, expires_in }
 *   Если Точка ротирует refresh_token — сохраняем новый в settings.
 *
 * ASSUMPTION F — внутренние переводы (счёт ↔ копилка):
 *   Назначение платежа содержит 'перевод' / 'пополнение копилки' / 'возврат из копилки'.
 *   Такие операции маппятся в category 'internal_transfer', исключаются из P&L.
 *
 * ASSUMPTION G — aggregated acquiring settlement:
 *   Зачисление от эквайринга на счёт Точки содержит 'эквайринг' / 'торговый эквайринг' /
 *   'платформа офд' в назначении. Маппится в category 'acquiring_settlement'.
 *
 * ASSUMPTION H — scope:
 *   'accounts balances customers statements sbp payments' (проверить в ЛК разработчика Точки).
 */

const log = childLogger({ handler: 'sync:tochka' });

// ── Константы ────────────────────────────────────────────────────────────

const TOCHKA_TOKEN_URL = 'https://enter.tochka.com/connect/token';
const TOCHKA_API_BASE = 'https://enter.tochka.com/uapi/open-banking/v1.0';

const HTTP_TIMEOUT_MS = 30_000;
const STATEMENT_POLL_MAX_ATTEMPTS = 5;
const STATEMENT_POLL_INTERVAL_MS = 3_000;

/** Settings key для хранения refresh_token Точки. */
const SETTINGS_KEY_REFRESH_TOKEN = 'tochka_refresh_token';

// ── Реальные UUID из БД (константы, см. задание) ─────────────────────────

/** Entity ИП Еремян (УСН 6%). ASSUMPTION: код 'IP' в реальной БД. */
const ENTITY_IP_ID = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
/** Entity ООО Ассургина (УСН 15%). ASSUMPTION: код 'OOO' в реальной БД. */
const ENTITY_OOO_ID = 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d';

// Категории расходов (коды из реальной схемы)
const EXPENSE_CATEGORY_CODES: Record<string, string> = {
  taxes: 'taxes',
  salary: 'salary',
  contractors: 'contractors',
  marketing: 'marketing',
  rent: 'rent',
  bank_fees: 'bank_fees',
  video: 'video',
  other_expense: 'other_expense',
  internal_transfer: 'internal_transfer',
};

// Ключевые слова для эвристической категоризации расходов (ASSUMPTION F, G)
const EXPENSE_KEYWORDS: Array<{ patterns: string[]; category: string }> = [
  { patterns: ['налог', 'фнс', 'ифнс', 'пенсионный', 'фсс', 'ффомс', 'взнос', 'усн'], category: 'taxes' },
  { patterns: ['зарплата', 'заработная плата', 'оклад', 'аванс сотрудни'], category: 'salary' },
  { patterns: ['подрядчик', 'исполнитель', 'договор оказания', 'вознаграждение'], category: 'contractors' },
  { patterns: ['реклама', 'маркетинг', 'яндекс', 'vk', 'вконтакте', 'таргет', 'контекст'], category: 'marketing' },
  { patterns: ['аренда', 'субаренда', 'офис', 'помещение', 'coworking', 'коворкинг'], category: 'rent' },
  { patterns: ['комиссия банка', 'bank fee', 'обслуживание счёта', 'абонентская плата', 'ведение счёта'], category: 'bank_fees' },
  { patterns: ['видео', 'монтаж', 'оператор', 'съёмка', 'продакшн', 'монтажёр'], category: 'video' },
];

// Ключевые слова для внутренних переводов (ASSUMPTION F)
const INTERNAL_TRANSFER_PATTERNS = [
  'перевод на накопительный',
  'пополнение копилки',
  'возврат из копилки',
  'перевод между счетами',
  'внутренний перевод',
  'перевод на сберегательный',
];

// Ключевые слова для зачислений эквайринга (ASSUMPTION G)
const ACQUIRING_SETTLEMENT_PATTERNS = [
  'эквайринг',
  'торговый эквайринг',
  'платформа офд',
  'нспк',
  'возмещение по эквайрингу',
  'выплата по эквайрингу',
];

// ── In-memory token cache ──────────────────────────────────────────────────

interface TokenState {
  accessToken: string;
  expiresAt: number; // unix ms
}

let tokenCache: TokenState | null = null;

function isTokenExpired(): boolean {
  if (tokenCache === null) return true;
  return Date.now() >= tokenCache.expiresAt;
}

// ── Zod-схемы ──────────────────────────────────────────────────────────────

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

/** ASSUMPTION A: поля из Open Banking UK + возможные Точка-расширения. */
const TochkaTxSchema = z.object({
  transactionId: z.string(),
  bookingDateTime: z.string(),
  amount: z.object({
    amount: z.string(),
    currency: z.string().default('RUB'),
  }),
  creditDebitIndicator: z.enum(['Credit', 'Debit']),
  transactionInformation: z.string().nullable().optional(),
  remittanceInformationUnstructured: z.string().nullable().optional(),
  status: z.string().default('Booked'),
});

type TochkaTxItem = z.infer<typeof TochkaTxSchema>;

/** ASSUMPTION C: поля счёта, включая баланс. */
const AccountSchema = z.object({
  accountId: z.string(),
  currency: z.string().default('RUB'),
  accountSubType: z.string().optional(),
  // ASSUMPTION C: баланс счёта (для копилок / основного счёта)
  Balance: z.array(z.object({
    Amount: z.object({
      Amount: z.string(),
      Currency: z.string().default('RUB'),
    }),
    CreditDebitIndicator: z.string().optional(),
    Type: z.string().optional(), // 'ClosingBooked' / 'Expected'
  })).optional(),
});

const AccountsResponseSchema = z.object({
  Data: z.object({
    Account: z.array(AccountSchema).default([]),
  }),
});

const InitStatementResponseSchema = z.object({
  Data: z.object({
    Statement: z.object({
      statementId: z.string(),
      status: z.string(),
    }),
  }),
});

const StatementReadySchema = z.object({
  Data: z.object({
    Statement: z.object({
      status: z.string(),
      Transaction: z.array(TochkaTxSchema).default([]),
    }),
  }),
});

// ── Typed errors ───────────────────────────────────────────────────────────

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

export class TokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

class StatementNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementNotReadyError';
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function httpFetch(url: string, options: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (res.status === 401) throw new TokenExpiredError(`HTTP 401 from ${url}`);
    if (res.status === 403) throw new CredentialsError(`HTTP 403 from ${url}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${context}: failed to parse JSON response`);
  }
}

// ── OAuth: authorization_code → tokens ────────────────────────────────────

/**
 * Обменивает authorization code на access_token + refresh_token.
 * Сохраняет refresh_token в settings.
 * Вызывается из GET /api/tochka/callback.
 *
 * ASSUMPTION D: POST https://enter.tochka.com/connect/token
 * с grant_type=authorization_code.
 */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const clientId = config.TOCHKA_CLIENT_ID;
  const clientSecret = config.TOCHKA_CLIENT_SECRET;
  const redirectUri = config.TOCHKA_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    throw new CredentialsError('TOCHKA_CLIENT_ID / TOCHKA_CLIENT_SECRET не заданы');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  log.info({ source: 'tochka' }, 'tochka_exchange_code');
  const raw = await httpFetch(TOCHKA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const parsed = TokenResponseSchema.safeParse(parseJson(raw, 'Tochka token exchange'));
  if (!parsed.success) {
    throw new Error(`Tochka token exchange: unexpected schema — ${parsed.error.message}`);
  }

  const { access_token, refresh_token, expires_in } = parsed.data;

  // Кэшируем access_token в памяти (с буфером 60с)
  tokenCache = {
    accessToken: access_token,
    expiresAt: Date.now() + (expires_in - 60) * 1000,
  };

  // Сохраняем refresh_token в БД (если Точка его вернула)
  if (refresh_token) {
    // updatedBy = OWNER_TG_ID (bigint)
    await setSetting(SETTINGS_KEY_REFRESH_TOKEN, refresh_token, config.OWNER_TG_ID);
    log.info({ source: 'tochka' }, 'tochka_refresh_token_saved');
  }
}

// ── OAuth: refresh_token → access_token ───────────────────────────────────

/**
 * Получает access_token через refresh grant.
 * Если Точка ротирует refresh_token — сохраняем новый.
 *
 * ASSUMPTION E: refresh grant возвращает новый refresh_token (rotation).
 */
async function refreshAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const refreshToken = await getSetting(SETTINGS_KEY_REFRESH_TOKEN);
  if (!refreshToken) {
    throw new CredentialsError(
      'Точка: refresh_token не найден в settings. ' +
      'Необходимо пройти OAuth-авторизацию через /api/tochka/callback.'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  log.info({ source: 'tochka' }, 'tochka_refresh_token_grant');
  const raw = await httpFetch(TOCHKA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const parsed = TokenResponseSchema.safeParse(parseJson(raw, 'Tochka refresh grant'));
  if (!parsed.success) {
    throw new Error(`Tochka refresh grant: unexpected schema — ${parsed.error.message}`);
  }

  const { access_token, refresh_token: newRefreshToken, expires_in } = parsed.data;

  // Кэшируем новый access_token
  tokenCache = {
    accessToken: access_token,
    expiresAt: Date.now() + (expires_in - 60) * 1000,
  };

  // ASSUMPTION E: Точка может ротировать refresh_token — сохраняем новый
  if (newRefreshToken) {
    await setSetting(SETTINGS_KEY_REFRESH_TOKEN, newRefreshToken, config.OWNER_TG_ID);
    log.info({ source: 'tochka' }, 'tochka_refresh_token_rotated');
  }

  return access_token;
}

/**
 * Возвращает действующий access_token (из кэша или через refresh).
 */
async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (!isTokenExpired() && tokenCache !== null) {
    return tokenCache.accessToken;
  }
  return refreshAccessToken(clientId, clientSecret);
}

// ── API helpers ────────────────────────────────────────────────────────────

async function apiGet(path: string, accessToken: string): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${TOCHKA_API_BASE}${path}`;
  const raw = await httpFetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return parseJson(raw, `Tochka GET ${path}`);
}

async function apiPost(path: string, body: unknown, accessToken: string): Promise<unknown> {
  const url = `${TOCHKA_API_BASE}${path}`;
  const raw = await httpFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  return parseJson(raw, `Tochka POST ${path}`);
}

/** GET с авто-рефрешем при 401. */
async function apiGetWithRefresh(
  path: string,
  clientId: string,
  clientSecret: string
): Promise<unknown> {
  let token = await getAccessToken(clientId, clientSecret);
  try {
    return await apiGet(path, token);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      log.info({ source: 'tochka' }, 'tochka_token_expired_refreshing');
      tokenCache = null;
      token = await getAccessToken(clientId, clientSecret);
      return await apiGet(path, token);
    }
    throw err;
  }
}

/** POST с авто-рефрешем при 401. */
async function apiPostWithRefresh(
  path: string,
  body: unknown,
  clientId: string,
  clientSecret: string
): Promise<unknown> {
  let token = await getAccessToken(clientId, clientSecret);
  try {
    return await apiPost(path, body, token);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      tokenCache = null;
      token = await getAccessToken(clientId, clientSecret);
      return await apiPost(path, body, token);
    }
    throw err;
  }
}

// ── Счета ─────────────────────────────────────────────────────────────────

interface AccountInfo {
  accountId: string;
  currency: string;
  accountSubType: string | undefined;
  balanceKopecks: bigint; // ASSUMPTION C: из Balance[].Amount.Amount
}

/**
 * Получает список счетов с балансами.
 * ASSUMPTION C: Balance массив с текущим балансом.
 */
async function fetchAccounts(clientId: string, clientSecret: string): Promise<AccountInfo[]> {
  const json = await apiGetWithRefresh('/accounts', clientId, clientSecret);
  const parsed = AccountsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Tochka accounts: unexpected schema — ${parsed.error.message}`);
  }

  return parsed.data.Data.Account.map((a) => {
    // Берём первый баланс типа ClosingBooked (или любой, если нет)
    const balEntry = a.Balance?.find((b) => b.Type === 'ClosingBooked') ?? a.Balance?.[0];
    let balanceKopecks = 0n;
    if (balEntry) {
      try {
        balanceKopecks = toKopecks(balEntry.Amount.Amount);
      } catch {
        balanceKopecks = 0n;
      }
    }
    return {
      accountId: a.accountId,
      currency: a.currency,
      accountSubType: a.accountSubType,
      balanceKopecks,
    };
  });
}

// ── Выписка (statement flow) ───────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Запрашивает выписку по счёту и поллит до Ready.
 * ASSUMPTION B: POST /statements → statementId; GET polling → Ready.
 */
async function fetchStatement(
  accountId: string,
  sinceDate: string,
  clientId: string,
  clientSecret: string
): Promise<TochkaTxItem[]> {
  const today = new Date().toISOString().slice(0, 10);

  const initBody = {
    Data: {
      Statement: {
        accountId,
        startDateTime: `${sinceDate}T00:00:00Z`,
        endDateTime: `${today}T23:59:59Z`,
      },
    },
  };

  const initJson = await apiPostWithRefresh('/statements', initBody, clientId, clientSecret);
  const initParsed = InitStatementResponseSchema.safeParse(initJson);
  if (!initParsed.success) {
    throw new Error(`Tochka initStatement: unexpected schema — ${initParsed.error.message}`);
  }

  const { statementId, status: initStatus } = initParsed.data.Data.Statement;
  log.info({ source: 'tochka', account_id: accountId, statement_id: statementId, status: initStatus }, 'tochka_statement_initiated');

  const pollPath = `/accounts/${encodeURIComponent(accountId)}/statements/${encodeURIComponent(statementId)}`;
  let attempt = 0;

  while (attempt < STATEMENT_POLL_MAX_ATTEMPTS) {
    if (attempt > 0) {
      await sleep(STATEMENT_POLL_INTERVAL_MS);
    }

    const pollJson = await apiGetWithRefresh(pollPath, clientId, clientSecret);
    const pollParsed = StatementReadySchema.safeParse(pollJson);
    if (!pollParsed.success) {
      throw new Error(`Tochka pollStatement: unexpected schema — ${pollParsed.error.message}`);
    }

    const { status, Transaction: txList } = pollParsed.data.Data.Statement;
    log.info({ source: 'tochka', account_id: accountId, poll_attempt: attempt + 1, status }, 'tochka_statement_poll');

    if (status === 'Ready') {
      return txList;
    }

    attempt++;
  }

  throw new StatementNotReadyError(
    `Tochka statement for account ${accountId} not ready after ${STATEMENT_POLL_MAX_ATTEMPTS} attempts`
  );
}

// ── Категоризация расходов ────────────────────────────────────────────────

/**
 * Простая эвристика: ищет ключевые слова в назначении платежа.
 * Возвращает код категории и признак needs_classification.
 *
 * ASSUMPTION F, G: ключевые слова по назначению платежа из выписки Точки.
 */
function categorizeExpense(description: string | null): {
  categoryCode: string;
  needsClassification: boolean;
  isInternalTransfer: boolean;
  isAcquiringSettlement: boolean;
} {
  const lower = (description ?? '').toLowerCase();

  // Внутренний перевод (ASSUMPTION F)
  if (INTERNAL_TRANSFER_PATTERNS.some((p) => lower.includes(p))) {
    return { categoryCode: 'internal_transfer', needsClassification: false, isInternalTransfer: true, isAcquiringSettlement: false };
  }

  // Зачисление эквайринга (ASSUMPTION G) — для income
  if (ACQUIRING_SETTLEMENT_PATTERNS.some((p) => lower.includes(p))) {
    return { categoryCode: 'acquiring_settlement', needsClassification: false, isInternalTransfer: false, isAcquiringSettlement: true };
  }

  // Категории расходов
  for (const { patterns, category } of EXPENSE_KEYWORDS) {
    if (patterns.some((p) => lower.includes(p))) {
      return { categoryCode: category, needsClassification: false, isInternalTransfer: false, isAcquiringSettlement: false };
    }
  }

  // Неизвестная категория — нужна ручная классификация
  return { categoryCode: 'other_expense', needsClassification: true, isInternalTransfer: false, isAcquiringSettlement: false };
}

// ── Резолвинг UUID из БД ───────────────────────────────────────────────────

/**
 * Загружает UUID категорий по кодам (ПОСЛЕДОВАТЕЛЬНО — pgBouncer).
 */
async function loadCategoryIds(codes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const code of codes) {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM categories WHERE code = ${code} LIMIT 1
    `;
    const id = rows[0]?.id;
    if (id) map.set(code, id);
  }
  return map;
}

/** Резолвит entity_id для счёта Точки (ИП или ООО по accountId или конфигу). */
async function resolveEntityForAccount(
  accountId: string
): Promise<string> {
  // ASSUMPTION: если accountId содержит признак ООО — возвращаем OOO, иначе IP.
  // На практике нужна конфигурация: какой accountId → какое юрлицо.
  // Пока возвращаем ООО (основной счёт ООО в Точке), можно переопределить через
  // настройку tochka_account_entity в settings.
  const settingKey = `tochka_entity_${accountId}`;
  const stored = await getSetting(settingKey);
  if (stored === 'IP') return ENTITY_IP_ID;
  if (stored === 'OOO') return ENTITY_OOO_ID;
  // ASSUMPTION: по умолчанию — ООО (основной расчётный счёт)
  return ENTITY_OOO_ID;
}

// ── Маппинг транзакций ─────────────────────────────────────────────────────

interface MappedTx {
  raw: RawSourceTransaction;
  flowType: 'income' | 'expense';
  categoryCode: string;
  needsClassification: boolean;
  isInternalTransfer: boolean;
  accountId: string;
}

function parseAmount(raw: string): bigint {
  try {
    const k = toKopecks(raw);
    return k > 0n ? k : 0n;
  } catch {
    return 0n;
  }
}

function mapTochkaTx(accountId: string, item: TochkaTxItem): MappedTx | null {
  if (item.status !== 'Booked') return null;

  const amount = parseAmount(item.amount.amount);
  if (amount <= 0n) return null;

  const occurredAt = item.bookingDateTime.slice(0, 10);
  const flowType: 'income' | 'expense' = item.creditDebitIndicator === 'Credit' ? 'income' : 'expense';

  // ASSUMPTION A: описание из одного из двух возможных полей
  const description =
    item.transactionInformation ??
    item.remittanceInformationUnstructured ??
    null;

  const { categoryCode, needsClassification, isInternalTransfer, isAcquiringSettlement } =
    categorizeExpense(description);

  // Для income тоже проверяем — например эквайринг-расчёт или внутренний перевод
  const effectiveCategory =
    flowType === 'income' && isAcquiringSettlement
      ? 'acquiring_settlement'
      : flowType === 'income' && isInternalTransfer
        ? 'internal_transfer'
        : flowType === 'income'
          ? 'other_income'
          : categoryCode;

  const raw: RawSourceTransaction = {
    externalId: `tochka_${item.transactionId}`,
    occurredAt,
    amount,
    currency: (item.amount.currency.toUpperCase() as 'RUB' | 'USD' | 'EUR' | 'KZT'),
    description,
    rawPayload: {
      accountId,
      transactionId: item.transactionId,
      creditDebitIndicator: item.creditDebitIndicator,
      // НЕ включаем персональные данные контрагента и суммы
    },
    needsClassification: flowType === 'income' ? false : needsClassification,
  };

  return {
    raw,
    flowType,
    categoryCode: effectiveCategory,
    needsClassification: flowType === 'income' ? false : needsClassification,
    isInternalTransfer,
    accountId,
  };
}

// ── Обновление балансов фондов ─────────────────────────────────────────────

/**
 * Обновляет funds.balance по соответствию funds.tochka_account_id → баланс счёта.
 * Все запросы ПОСЛЕДОВАТЕЛЬНО (pgBouncer transaction mode).
 *
 * ASSUMPTION C: баланс берётся из поля Balance[ClosingBooked].Amount.Amount.
 */
async function syncFundBalances(accounts: AccountInfo[]): Promise<number> {
  let updated = 0;
  for (const account of accounts) {
    if (account.balanceKopecks === 0n) continue; // пропускаем счета без баланса

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM funds
      WHERE tochka_account_id = ${account.accountId}
        AND deleted_at IS NULL
      LIMIT 1
    `;

    if (rows[0]) {
      const fundId = rows[0].id;
      await sql`
        UPDATE funds
        SET balance = ${account.balanceKopecks}
        WHERE id = ${fundId}
      `;
      updated++;
      log.info(
        { source: 'tochka', account_id: account.accountId, fund_id: fundId },
        'tochka_fund_balance_updated'
      );
    }
  }
  return updated;
}

// ── SourceSyncer implementation ────────────────────────────────────────────

/**
 * syncTochka — полный цикл синхронизации Точки:
 *   1. Получить счета и их балансы.
 *   2. Для каждого счёта — запросить выписку.
 *   3. Маппировать операции (income/expense/internal_transfer).
 *   4. Вставить в transactions (ПОСЛЕДОВАТЕЛЬНО, дедуп по external_id).
 *   5. Обновить balances фондов (по tochka_account_id).
 *
 * Все запросы к БД строго последовательно — pgBouncer transaction mode.
 */
export const tochkaSyncer: SourceSyncer = {
  code: 'tochka',

  async sync(sinceDate: string): Promise<SyncResult> {
    const clientId = config.TOCHKA_CLIENT_ID;
    const clientSecret = config.TOCHKA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      log.warn({ source: 'tochka' }, 'tochka_credentials_missing');
      return { fetched: 0, inserted: 0 };
    }

    // 1. Получаем список счетов с балансами (ПОСЛЕДОВАТЕЛЬНО)
    let accounts: AccountInfo[];
    try {
      accounts = await fetchAccounts(clientId, clientSecret);
    } catch (err) {
      if (err instanceof CredentialsError) {
        log.error({ source: 'tochka', err: String(err) }, 'tochka_credentials_error');
        return { fetched: 0, inserted: 0 };
      }
      throw err;
    }

    if (accounts.length === 0) {
      log.warn({ source: 'tochka' }, 'tochka_no_accounts_found');
      return { fetched: 0, inserted: 0 };
    }
    log.info({ source: 'tochka', accounts: accounts.length }, 'tochka_accounts_found');

    // 2. Получаем выписки по каждому счёту (ПОСЛЕДОВАТЕЛЬНО — pgBouncer)
    const allMapped: MappedTx[] = [];
    for (const account of accounts) {
      let txItems: TochkaTxItem[];
      try {
        txItems = await fetchStatement(account.accountId, sinceDate, clientId, clientSecret);
      } catch (err) {
        if (err instanceof StatementNotReadyError) {
          log.warn({ source: 'tochka', account_id: account.accountId, err: String(err) }, 'tochka_statement_not_ready');
          continue;
        }
        throw err;
      }

      for (const item of txItems) {
        const mapped = mapTochkaTx(account.accountId, item);
        if (mapped) allMapped.push(mapped);
      }
    }

    log.info({ source: 'tochka', fetched: allMapped.length }, 'tochka_fetched');

    // 3. Загружаем нужные category_id (ПОСЛЕДОВАТЕЛЬНО)
    const neededCodes = [
      ...new Set(allMapped.map((m) => m.categoryCode).filter(Boolean)),
    ];
    const categoryIds = await loadCategoryIds(neededCodes);

    // created_by = OWNER_TG_ID (bigint)
    const createdBy: bigint = config.OWNER_TG_ID;

    // 4. Вставляем транзакции (ПОСЛЕДОВАТЕЛЬНО, grouped by account+flowType)
    let totalInserted = 0;
    for (const mapped of allMapped) {
      const entityId = await resolveEntityForAccount(mapped.accountId);
      const categoryId = categoryIds.get(mapped.categoryCode) ?? null;

      // Внутренние переводы маппим в expense с нулевым влиянием на P&L
      // (category internal_transfer исключается из P&L на уровне аналитики)
      const txInserted = await insertSyncTransactions({
        sourceCode: 'tochka',
        transactions: [mapped.raw],
        createdBy,
        entityId,
        directionId: null, // Точка не знает направление — нужна ручная классификация
        categoryId,
        flowType: mapped.flowType,
      });
      totalInserted += txInserted;
    }

    // 5. Обновляем балансы фондов по tochka_account_id (ПОСЛЕДОВАТЕЛЬНО)
    const fundsUpdated = await syncFundBalances(accounts);
    log.info({ source: 'tochka', funds_updated: fundsUpdated }, 'tochka_fund_balances_synced');

    return { fetched: allMapped.length, inserted: totalInserted };
  },
};

// ── Публичный экспорт для cron/ручного вызова ────────────────────────────

/**
 * Запускает синхронизацию Точки с указанной даты.
 * Обёртка над tochkaSyncer.sync с логированием.
 */
export async function syncTochka(sinceDate?: string): Promise<SyncResult> {
  const since = sinceDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  log.info({ source: 'tochka', since }, 'tochka_sync_start');
  const result = await tochkaSyncer.sync(since);
  log.info({ source: 'tochka', ...result }, 'tochka_sync_done');
  return result;
}
