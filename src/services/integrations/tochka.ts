import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import { toKopecks } from '../../utils/money.js';
import type { SourceSyncer, SyncResult, RawSourceTransaction } from './types.js';
import { insertSyncTransactions } from '../../db/repositories/integrations.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { sql } from '../../db/client.js';

/**
 * Точка Банк — pull-синхронизатор на реальном Open Banking API.
 *
 * Поток:
 *   1. OAuth client_credentials → access_token (24ч, кэш в памяти).
 *   2. GET /accounts → список accountId.
 *   3. Для каждого счёта:
 *      a. POST /statements → statementId + статус.
 *      b. Поллинг GET /accounts/{id}/statements/{sid} пока status !== 'Ready'.
 *      c. Маппинг Transaction[] → RawSourceTransaction[].
 *   4. Пакетная дедуп-вставка через insertSyncTransactions.
 *
 * ────────── ASSUMPTIONS (требуют сверки на реальном API) ──────────
 *
 * ASSUMPTION A — имена полей Transaction:
 *   Использованы официальные имена Open Banking UK (которым Точка следует).
 *   Конкретные имена: transactionId, amount.amount, amount.currency,
 *   creditDebitIndicator ('Credit'/'Debit'), bookingDateTime (ISO 8601),
 *   transactionInformation / remittanceInformationUnstructured (описание),
 *   status ('Booked'/'Pending').
 *   ВАЖНО: сверить на реальном вебхуке/ответе Точки — имена могут отличаться
 *   от стандарта (напр., DocumentProductDateTime вместо bookingDateTime).
 *
 * ASSUMPTION B — statement flow:
 *   POST /statements → { Data: { Statement: { statementId, status } } }
 *   GET  /accounts/{id}/statements/{sid} → { Data: { Statement: { status, Transaction: [] } } }
 *   Статусы: Created → Processing → Ready.
 *   Если через 5 попыток статус не Ready — бросаем ошибку.
 *
 * ASSUMPTION C — authorization_code flow:
 *   Для полного доступа к выпискам Точка может требовать authorization_code + consent.
 *   TODO: если client_credentials не даёт доступа к /statements —
 *   добавить обработчик /api/oauth/tochka/callback и хранить refresh_token в БД.
 *   Сейчас реализован только client_credentials.
 *
 * ASSUMPTION D — scope:
 *   Точка требует: 'accounts balances customers statements sbp payments'.
 *   Проверить в настройках приложения в личном кабинете разработчика.
 */

const log = childLogger({ handler: 'sync:tochka' });

// ── Константы ────────────────────────────────────────────────────────────

const TOCHKA_TOKEN_URL = 'https://enter.tochka.com/connect/token';
const TOCHKA_API_BASE = 'https://enter.tochka.com/uapi/open-banking/v1.0';

// ASSUMPTION D: scope из официальной документации
const TOCHKA_SCOPE = 'accounts balances customers statements sbp payments';

const HTTP_TIMEOUT_MS = 30_000;

/** Максимальное число попыток поллинга статуса выписки. */
const STATEMENT_POLL_MAX_ATTEMPTS = 5;
/** Пауза между попытками поллинга (мс). */
const STATEMENT_POLL_INTERVAL_MS = 3_000;

// ── In-memory token cache ─────────────────────────────────────────────────

interface TokenState {
  accessToken: string;
  expiresAt: number; // unix ms
}

let tokenState: TokenState | null = null;

function isTokenExpired(): boolean {
  if (tokenState === null) return true;
  return Date.now() >= tokenState.expiresAt;
}

// ── Zod-схемы ─────────────────────────────────────────────────────────────

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const AccountSchema = z.object({
  accountId: z.string(),
  currency: z.string().default('RUB'),
  accountSubType: z.string().optional(),
});

const AccountsResponseSchema = z.object({
  Data: z.object({
    Account: z.array(AccountSchema).default([]),
  }),
});

/** Ответ на инициацию выписки. ASSUMPTION B */
const InitStatementResponseSchema = z.object({
  Data: z.object({
    Statement: z.object({
      statementId: z.string(),
      status: z.string(),
    }),
  }),
});

/** Одна операция из выписки Точки. ASSUMPTION A */
const TochkaTxSchema = z.object({
  // ASSUMPTION A: официальные Open Banking поля
  transactionId: z.string(),
  bookingDateTime: z.string(),
  amount: z.object({
    amount: z.string(),
    currency: z.string().default('RUB'),
  }),
  creditDebitIndicator: z.enum(['Credit', 'Debit']),
  // Описание — одно из двух возможных полей (ASSUMPTION A)
  transactionInformation: z.string().nullable().optional(),
  remittanceInformationUnstructured: z.string().nullable().optional(),
  status: z.string().default('Booked'),
});

/** Ответ с выпиской (после Ready). ASSUMPTION B */
const StatementReadySchema = z.object({
  Data: z.object({
    Statement: z.object({
      status: z.string(),
      Transaction: z.array(TochkaTxSchema).default([]),
    }),
  }),
});

// ── Typed errors ──────────────────────────────────────────────────────────

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

class TokenExpiredError extends Error {
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

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function httpFetch(
  url: string,
  options: RequestInit
): Promise<string> {
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

// ── OAuth ─────────────────────────────────────────────────────────────────

async function fetchNewToken(clientId: string, clientSecret: string): Promise<TokenState> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: TOCHKA_SCOPE,
  });

  log.info({ source: 'tochka' }, 'tochka_fetching_token');
  const raw = await httpFetch(TOCHKA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const parsed = TokenResponseSchema.safeParse(parseJson(raw, 'Tochka OAuth'));
  if (!parsed.success) {
    throw new Error(`Tochka OAuth: unexpected token schema — ${parsed.error.message}`);
  }

  // 24ч токен, буфер 60с
  return {
    accessToken: parsed.data.access_token,
    expiresAt: Date.now() + (parsed.data.expires_in - 60) * 1000,
  };
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (isTokenExpired()) {
    tokenState = await fetchNewToken(clientId, clientSecret);
  }
  return tokenState!.accessToken;
}

// ── API helpers ───────────────────────────────────────────────────────────

async function apiGet(
  path: string,
  accessToken: string
): Promise<unknown> {
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

async function apiPost(
  path: string,
  body: unknown,
  accessToken: string
): Promise<unknown> {
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

/**
 * Выполняет GET с авто-рефрешем при TokenExpiredError (401).
 */
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
      tokenState = null;
      token = await getAccessToken(clientId, clientSecret);
      return await apiGet(path, token);
    }
    throw err;
  }
}

/**
 * Выполняет POST с авто-рефрешем при 401.
 */
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
      tokenState = null;
      token = await getAccessToken(clientId, clientSecret);
      return await apiPost(path, body, token);
    }
    throw err;
  }
}

// ── Счета ─────────────────────────────────────────────────────────────────

async function fetchAccountIds(clientId: string, clientSecret: string): Promise<string[]> {
  const json = await apiGetWithRefresh('/accounts', clientId, clientSecret);
  const parsed = AccountsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Tochka accounts: unexpected schema — ${parsed.error.message}`);
  }
  return parsed.data.Data.Account.map((a) => a.accountId);
}

// ── Выписка (statement flow) ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Инициирует запрос выписки и поллит статус до Ready.
 * ASSUMPTION B: POST /statements → statementId; GET polling → Ready.
 */
async function fetchStatement(
  accountId: string,
  sinceDate: string,
  clientId: string,
  clientSecret: string
): Promise<RawSourceTransaction[]> {
  const today = new Date().toISOString().slice(0, 10);

  // Шаг 1: инициировать выписку
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

  // Шаг 2: поллим статус
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
      return mapTransactions(accountId, txList);
    }

    // Created / Processing — продолжаем поллинг
    attempt++;
  }

  throw new StatementNotReadyError(
    `Tochka statement ${statementId} for account ${accountId} not ready after ${STATEMENT_POLL_MAX_ATTEMPTS} attempts`
  );
}

// ── Маппинг операций ──────────────────────────────────────────────────────

type TochkaTxItem = z.infer<typeof TochkaTxSchema>;

/** "1500.50" → 150050n копеек. */
function parseAmount(raw: string): bigint {
  try {
    const k = toKopecks(raw);
    return k > 0n ? k : 0n;
  } catch {
    return 0n;
  }
}

/** ISO 8601 datetime → YYYY-MM-DD */
function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function mapTransactions(accountId: string, items: TochkaTxItem[]): RawSourceTransaction[] {
  const result: RawSourceTransaction[] = [];

  for (const item of items) {
    // Только подтверждённые операции
    if (item.status !== 'Booked') continue;

    const amount = parseAmount(item.amount.amount);
    if (amount <= 0n) continue;

    const occurredAt = toDateOnly(item.bookingDateTime);
    const flowType: 'income' | 'expense' = item.creditDebitIndicator === 'Credit' ? 'income' : 'expense';

    // ASSUMPTION A: описание из одного из двух полей
    const description =
      item.transactionInformation ??
      item.remittanceInformationUnstructured ??
      null;

    result.push({
      externalId: `tochka_${accountId}_${item.transactionId}`,
      occurredAt,
      amount,
      currency: (item.amount.currency.toUpperCase() as 'RUB' | 'USD' | 'EUR' | 'KZT'),
      description,
      rawPayload: {
        accountId,
        transactionId: item.transactionId,
        creditDebitIndicator: item.creditDebitIndicator,
        flowType,
        status: item.status,
        // НЕ включаем персональные данные контрагента и суммы
      },
    });
  }

  return result;
}

// ── SourceSyncer implementation ───────────────────────────────────────────

export const tochkaSyncer: SourceSyncer = {
  code: 'tochka',

  async sync(sinceDate: string): Promise<SyncResult> {
    const clientId = config.TOCHKA_CLIENT_ID;
    const clientSecret = config.TOCHKA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      log.warn({ source: 'tochka' }, 'tochka_credentials_missing');
      return { fetched: 0, inserted: 0 };
    }

    // 1. Получаем список счетов
    const accountIds = await fetchAccountIds(clientId, clientSecret);
    if (accountIds.length === 0) {
      log.warn({ source: 'tochka' }, 'tochka_no_accounts_found');
      return { fetched: 0, inserted: 0 };
    }
    log.info({ source: 'tochka', accounts: accountIds.length }, 'tochka_accounts_found');

    // 2. Для каждого счёта запрашиваем выписку через statement flow
    const allRaw: RawSourceTransaction[] = [];
    for (const accountId of accountIds) {
      try {
        const txs = await fetchStatement(accountId, sinceDate, clientId, clientSecret);
        allRaw.push(...txs);
      } catch (err) {
        // StatementNotReady — логируем и пропускаем счёт, не роняем весь синк
        if (err instanceof StatementNotReadyError) {
          log.warn({ source: 'tochka', account_id: accountId, err: String(err) }, 'tochka_statement_not_ready');
          continue;
        }
        throw err;
      }
    }

    log.info({ source: 'tochka', fetched: allRaw.length }, 'tochka_fetched');
    if (allRaw.length === 0) return { fetched: 0, inserted: 0 };

    // 3. entity_id из sources.entity_id для Точки (ООО)
    const entityRows = await sql<{ entity_id: string | null }[]>`
      SELECT entity_id FROM sources WHERE code = 'tochka' LIMIT 1
    `;
    const entityId = entityRows[0]?.entity_id;
    if (!entityId) {
      log.warn({ source: 'tochka' }, 'tochka_entity_id_missing');
      return { fetched: allRaw.length, inserted: 0 };
    }

    // 4. created_by = owner
    const users = await getAllActiveUsers();
    const owner = users.find((u) => u.role === 'owner');
    if (!owner) {
      log.warn({ source: 'tochka' }, 'tochka_no_owner_user');
      return { fetched: allRaw.length, inserted: 0 };
    }

    // 5. Разбиваем на income/expense (Tochka даёт оба)
    const incomeRaw = allRaw.filter((t) => t.rawPayload['flowType'] === 'income');
    const expenseRaw = allRaw.filter((t) => t.rawPayload['flowType'] === 'expense');

    let totalInserted = 0;

    if (incomeRaw.length > 0) {
      const ins = await insertSyncTransactions({
        sourceCode: 'tochka',
        transactions: incomeRaw,
        createdBy: owner.id,
        entityId,
        directionId: null,
        categoryId: null,
        flowType: 'income',
      });
      totalInserted += ins;
    }

    if (expenseRaw.length > 0) {
      const ins = await insertSyncTransactions({
        sourceCode: 'tochka',
        transactions: expenseRaw,
        createdBy: owner.id,
        entityId,
        directionId: null,
        categoryId: null,
        flowType: 'expense',
      });
      totalInserted += ins;
    }

    return { fetched: allRaw.length, inserted: totalInserted };
  },
};
