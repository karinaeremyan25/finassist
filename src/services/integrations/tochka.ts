import { z } from 'zod';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import type { SourceSyncer, SyncResult, RawSourceTransaction } from './types.js';
import { insertSyncTransactions } from '../../db/repositories/integrations.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { sql } from '../../db/client.js';

/**
 * Точка Банк (Tochka) OAuth 2.0 синхронизатор.
 *
 * Реализует:
 * - OAuth 2.0 client_credentials / authorization_code flow.
 * - Хранение access_token + refresh_token в памяти (для одного процесса PM2).
 * - Авто-рефреш по refresh_token при 401; при провале — CredentialsError.
 * - Загрузку выписки по расчётному счёту ООО.
 *
 * ────────── ASSUMPTIONS (требуют сверки с реальной документацией) ──────────
 *
 * ASSUMPTION 1: OAuth 2.0 endpoints
 *   Token URL: https://enter.tochka.com/connect/token
 *   API base: https://enter.tochka.com/uapi/open-banking/v1.0
 *   Документация: https://enter.tochka.com/documentation/api/open-banking
 *
 * ASSUMPTION 2: grant_type
 *   Используется client_credentials для серверного доступа:
 *     POST /connect/token
 *     Body (form): grant_type=client_credentials&client_id=...&client_secret=...&scope=accounts transactions
 *   ВАЖНО: Точка может требовать предварительного consent (authorization_code).
 *          Если банк требует интерактивной авторизации — нужно доработать
 *          flow с redirect_uri (описан ниже в TODO).
 *
 * ASSUMPTION 3: список счетов
 *   GET /accounts → { Data: { Account: AccountItem[] } }
 *   AccountItem: { AccountId: string, Currency: string, AccountSubType: string, ... }
 *   Фильтруем по AccountSubType='CurrentAccount' (расчётный счёт).
 *
 * ASSUMPTION 4: выписка
 *   GET /accounts/{AccountId}/transactions?fromBookingDateTime=...&toBookingDateTime=...
 *   Response: { Data: { Transaction: TransactionItem[] } }
 *   TransactionItem: {
 *     TransactionId: string,
 *     BookingDateTime: string,     — ISO 8601 с временем
 *     Amount: { Amount: string, Currency: string },
 *     CreditDebitIndicator: 'Credit' | 'Debit',
 *     TransactionInformation: string | null,
 *     Status: 'Booked' | 'Pending',
 *   }
 *
 * ASSUMPTION 5: суммы
 *   Amount.Amount — строка в рублях ("1500.00").
 *   Credit → income, Debit → expense.
 *   Конвертируем в копейки через round(amount * 100).
 *
 * ASSUMPTION 6: пагинация
 *   Ответ может содержать Links.Next (ссылка на следующую страницу).
 *   Продолжаем запрашивать пока Links.Next присутствует.
 *
 * ASSUMPTION 7: токен-хранилище
 *   Хранится в памяти (Map). При рестарте PM2 — авто-рефреш на следующем запросе.
 *   access_token_expiry = now + expires_in - 60s (буфер).
 *
 * TODO: если требуется authorization_code flow — добавить обработчик callback
 *   в src/server/ и хранить refresh_token в БД (settings таблица).
 * ──────────────────────────────────────────────────────────────────────────
 */

const log = childLogger({ handler: 'sync:tochka' });

// ── Константы ────────────────────────────────────────────────────────────

// ASSUMPTION 1: OAuth и API endpoints
const TOCHKA_TOKEN_URL = 'https://enter.tochka.com/connect/token';
const TOCHKA_API_BASE = 'https://enter.tochka.com/uapi/open-banking/v1.0';

const HTTP_TIMEOUT_MS = 30_000;
// ASSUMPTION 2: запрашиваемые scopes
const TOCHKA_SCOPES = 'accounts transactions';

// ── In-memory token storage ───────────────────────────────────────────────

interface TokenState {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // unix ms
}

/** Хранение токена в памяти для одного PM2-процесса. */
let tokenState: TokenState | null = null;

function isTokenExpired(): boolean {
  if (tokenState === null) return true;
  return Date.now() >= tokenState.expiresAt;
}

// ── Zod-схемы ─────────────────────────────────────────────────────────────

const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

const AccountSchema = z.object({
  AccountId: z.string(),
  Currency: z.string().default('RUB'),
  AccountSubType: z.string().optional(),
});

const AccountsResponseSchema = z.object({
  Data: z.object({
    Account: z.array(AccountSchema).default([]),
  }),
});

const TxAmountSchema = z.object({
  Amount: z.string(),
  Currency: z.string().default('RUB'),
});

const TochkaTxSchema = z.object({
  TransactionId: z.string(),
  BookingDateTime: z.string(),
  Amount: TxAmountSchema,
  CreditDebitIndicator: z.enum(['Credit', 'Debit']),
  TransactionInformation: z.string().nullable().optional(),
  Status: z.string().default('Booked'),
});

const TransactionsResponseSchema = z.object({
  Data: z.object({
    Transaction: z.array(TochkaTxSchema).default([]),
  }),
  Links: z.object({
    Next: z.string().optional(),
  }).optional(),
});

// ── CredentialsError ──────────────────────────────────────────────────────

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

// ── OAuth helpers ─────────────────────────────────────────────────────────

/**
 * Запрашивает новый access_token через client_credentials.
 */
async function fetchTokenClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<TokenState> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    // НЕ логируем client_secret
    client_secret: clientSecret,
    scope: TOCHKA_SCOPES,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let responseBody: string;
  try {
    const res = await fetch(TOCHKA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new CredentialsError(`Tochka OAuth responded with HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`Tochka OAuth HTTP ${res.status}`);
    }
    responseBody = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(responseBody);
  } catch {
    throw new Error('Tochka: failed to parse token response');
  }

  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Tochka: unexpected token response schema — ${parsed.error.message}`);
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    // expiresAt = now + expires_in - 60s (буфер для перекрытия)
    expiresAt: Date.now() + (parsed.data.expires_in - 60) * 1000,
  };
}

/**
 * Пробует обновить токен через refresh_token.
 * При ошибке — запрашивает новый через client_credentials.
 */
async function refreshToken(
  clientId: string,
  clientSecret: string,
  refreshTokenValue: string
): Promise<TokenState> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshTokenValue,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let responseBody: string;
  try {
    const res = await fetch(TOCHKA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      // refresh_token невалиден — пробуем заново через client_credentials
      log.warn({ source: 'tochka' }, 'tochka_refresh_token_invalid_retrying_cc');
      return await fetchTokenClientCredentials(clientId, clientSecret);
    }
    if (!res.ok) {
      throw new Error(`Tochka refresh HTTP ${res.status}`);
    }
    responseBody = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(responseBody);
  } catch {
    throw new Error('Tochka: failed to parse refresh token response');
  }

  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    return await fetchTokenClientCredentials(clientId, clientSecret);
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? tokenState?.refreshToken ?? null,
    expiresAt: Date.now() + (parsed.data.expires_in - 60) * 1000,
  };
}

/**
 * Возвращает валидный access_token (авто-рефреш при истечении).
 */
async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (isTokenExpired()) {
    if (tokenState?.refreshToken) {
      log.info({ source: 'tochka' }, 'tochka_refreshing_token');
      tokenState = await refreshToken(clientId, clientSecret, tokenState.refreshToken);
    } else {
      log.info({ source: 'tochka' }, 'tochka_fetching_new_token');
      tokenState = await fetchTokenClientCredentials(clientId, clientSecret);
    }
  }
  return tokenState!.accessToken;
}

// ── API helpers ───────────────────────────────────────────────────────────

async function apiGet(url: string, accessToken: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let responseBody: string;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401) {
      // Токен истёк прямо сейчас — сигналим для рефреша
      throw new TokenExpiredError('Tochka API 401 — token expired');
    }
    if (res.status === 403) {
      throw new CredentialsError(`Tochka API responded with HTTP 403`);
    }
    if (!res.ok) {
      throw new Error(`Tochka API HTTP ${res.status} for ${url}`);
    }

    responseBody = await res.text();
  } finally {
    clearTimeout(timer);
  }

  return JSON.parse(responseBody);
}

class TokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

/**
 * Выполняет GET с авто-рефрешем при 401.
 */
async function apiGetWithRefresh(
  url: string,
  clientId: string,
  clientSecret: string
): Promise<unknown> {
  let accessToken = await getAccessToken(clientId, clientSecret);
  try {
    return await apiGet(url, accessToken);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // Форсируем рефреш
      tokenState = null;
      accessToken = await getAccessToken(clientId, clientSecret);
      return await apiGet(url, accessToken);
    }
    throw err;
  }
}

// ── Загрузка счетов ────────────────────────────────────────────────────────

async function fetchCurrentAccounts(
  clientId: string,
  clientSecret: string
): Promise<string[]> {
  const url = `${TOCHKA_API_BASE}/accounts`;
  const json = await apiGetWithRefresh(url, clientId, clientSecret);

  const parsed = AccountsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Tochka: unexpected accounts schema — ${parsed.error.message}`);
  }

  // ASSUMPTION 3: фильтруем CurrentAccount
  return parsed.data.Data.Account
    .filter((a) => !a.AccountSubType || a.AccountSubType === 'CurrentAccount')
    .map((a) => a.AccountId);
}

// ── Загрузка транзакций ───────────────────────────────────────────────────

/** "1500.50" → 150050n */
function parseRubToKopecks(raw: string): bigint {
  const num = parseFloat(raw.replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return 0n;
  return BigInt(Math.round(num * 100));
}

/** ISO datetime → YYYY-MM-DD */
function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

async function fetchAccountTransactions(
  accountId: string,
  sinceDate: string,
  clientId: string,
  clientSecret: string
): Promise<RawSourceTransaction[]> {
  const today = new Date().toISOString().slice(0, 10);
  const fromDT = `${sinceDate}T00:00:00Z`;
  const toDT = `${today}T23:59:59Z`;

  const baseUrl =
    `${TOCHKA_API_BASE}/accounts/${encodeURIComponent(accountId)}/transactions` +
    `?fromBookingDateTime=${encodeURIComponent(fromDT)}` +
    `&toBookingDateTime=${encodeURIComponent(toDT)}`;

  const result: RawSourceTransaction[] = [];
  let nextUrl: string | undefined = baseUrl;

  while (nextUrl !== undefined) {
    const json = await apiGetWithRefresh(nextUrl, clientId, clientSecret);
    const parsed = TransactionsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Tochka: unexpected transactions schema — ${parsed.error.message}`);
    }

    for (const item of parsed.data.Data.Transaction) {
      // Только подтверждённые операции
      if (item.Status !== 'Booked') continue;

      const amount = parseRubToKopecks(item.Amount.Amount);
      if (amount <= 0n) continue;

      const occurredAt = toDateOnly(item.BookingDateTime);
      const flowType = item.CreditDebitIndicator === 'Credit' ? 'income' : 'expense';

      result.push({
        externalId: `tochka_${accountId}_${item.TransactionId}`,
        occurredAt,
        amount,
        currency: (item.Amount.Currency.toUpperCase() as 'RUB' | 'USD' | 'EUR' | 'KZT') ?? 'RUB',
        description: item.TransactionInformation ?? null,
        rawPayload: {
          accountId,
          transactionId: item.TransactionId,
          creditDebitIndicator: item.CreditDebitIndicator,
          flowType,
          status: item.Status,
          // НЕ включаем персональные данные контрагента
        },
      });
    }

    nextUrl = parsed.data.Links?.Next;
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

    // Загружаем счета ООО
    const accountIds = await fetchCurrentAccounts(clientId, clientSecret);
    if (accountIds.length === 0) {
      log.warn({ source: 'tochka' }, 'tochka_no_accounts_found');
      return { fetched: 0, inserted: 0 };
    }

    log.info({ source: 'tochka', accounts: accountIds.length }, 'tochka_accounts_found');

    // Загружаем транзакции по всем счетам
    const allRaw: RawSourceTransaction[] = [];
    for (const accountId of accountIds) {
      const txs = await fetchAccountTransactions(accountId, sinceDate, clientId, clientSecret);
      allRaw.push(...txs);
    }

    log.info({ source: 'tochka', fetched: allRaw.length }, 'tochka_fetched');

    if (allRaw.length === 0) return { fetched: 0, inserted: 0 };

    // Резолвим entity_id для ООО из sources.entity_id
    const entityRows = await sql<{ entity_id: string | null }[]>`
      SELECT entity_id FROM sources WHERE code = 'tochka' LIMIT 1
    `;
    const entityId = entityRows[0]?.entity_id;
    if (!entityId) {
      log.warn({ source: 'tochka' }, 'tochka_entity_id_missing');
      return { fetched: allRaw.length, inserted: 0 };
    }

    // created_by — owner
    const users = await getAllActiveUsers();
    const owner = users.find((u) => u.role === 'owner');
    if (!owner) {
      log.warn({ source: 'tochka' }, 'tochka_no_owner_user');
      return { fetched: allRaw.length, inserted: 0 };
    }

    // Разбиваем на income/expense — у Tochka бывают оба
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
