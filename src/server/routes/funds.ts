/**
 * GET /api/analytics/funds — список фондов + последние движения.
 *
 * Используется экраном «Фонды» Mini App.
 * Авторизация через resolveWebAppUser (X-Telegram-Init-Data).
 *
 * Ответ:
 * {
 *   funds: [
 *     {
 *       id: string,
 *       code: string,
 *       name: string,
 *       balance: number,        // копейки (фронт форматирует)
 *       recentMovements: [
 *         { amount: number, description: string | null, date: string, kind: 'in' | 'out' }
 *       ]
 *     }
 *   ]
 * }
 *
 * Все запросы к БД СТРОГО ПОСЛЕДОВАТЕЛЬНО — pgBouncer (transaction mode, порт 6543)
 * в serverless виснет на параллельных запросах (Promise.all → 504 timeout).
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import { sql } from '../../db/client.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'funds' });

// ── Лимит последних движений на фонд ─────────────────────────────────────
const RECENT_MOVEMENTS_LIMIT = 10;

// ── Zod-схема для строк из БД ─────────────────────────────────────────────

const FundRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  balance: z.bigint().nullable(),
});

const FundTxRowSchema = z.object({
  fund_id: z.string(),
  amount: z.bigint(),
  description: z.string().nullable(),
  created_at: z.union([z.string(), z.date()]),
});

// ── Типы ──────────────────────────────────────────────────────────────────

interface FundMovement {
  amount: bigint;
  description: string | null;
  date: string;
  kind: 'in' | 'out';
}

interface FundItem {
  id: string;
  code: string;
  name: string;
  balance: bigint;
  recentMovements: FundMovement[];
}

// ── Helper: нормализовать дату к YYYY-MM-DD ───────────────────────────────

function toDateStr(val: string | Date): string {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

// ── GET /api/analytics/funds ──────────────────────────────────────────────

export const fundsHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    // 1. Список всех активных фондов (ПОСЛЕДОВАТЕЛЬНО)
    const fundRows = await sql<Array<{
      id: string;
      code: string;
      name: string;
      balance: bigint | null;
    }>>`
      SELECT id, code, name, COALESCE(balance, 0)::bigint AS balance
      FROM funds
      WHERE deleted_at IS NULL
        AND is_active = true
      ORDER BY code ASC
    `;

    // Валидируем строки через Zod
    const validatedFunds = fundRows
      .map((r) => FundRowSchema.safeParse(r))
      .filter((p) => p.success)
      .map((p) => (p as { success: true; data: z.infer<typeof FundRowSchema> }).data);

    // 2. Для каждого фонда — последние N движений (ПОСЛЕДОВАТЕЛЬНО, не Promise.all)
    const funds: FundItem[] = [];

    for (const fund of validatedFunds) {
      const txRows = await sql<Array<{
        fund_id: string;
        amount: bigint;
        description: string | null;
        created_at: Date | string;
      }>>`
        SELECT fund_id, amount, description, created_at
        FROM fund_transactions
        WHERE fund_id = ${fund.id}
        ORDER BY created_at DESC
        LIMIT ${RECENT_MOVEMENTS_LIMIT}
      `;

      const validatedTxs = txRows
        .map((r) => FundTxRowSchema.safeParse(r))
        .filter((p) => p.success)
        .map((p) => (p as { success: true; data: z.infer<typeof FundTxRowSchema> }).data);

      const recentMovements: FundMovement[] = validatedTxs.map((tx) => ({
        amount: tx.amount < 0n ? -tx.amount : tx.amount,
        description: tx.description,
        date: toDateStr(tx.created_at),
        kind: tx.amount >= 0n ? 'in' : 'out',
      }));

      funds.push({
        id: fund.id,
        code: fund.code,
        name: fund.name,
        balance: fund.balance ?? 0n,
        recentMovements,
      });
    }

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'funds',
        funds_count: funds.length,
        latency_ms: Date.now() - start,
      },
      'analytics_funds_ok'
    );

    return {
      status: 200,
      body: { funds },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);

    log.error(
      { err, handler: 'funds', latency_ms: Date.now() - start },
      'analytics_funds_error'
    );

    // Деградация: пустой список вместо 500
    return {
      status: 200,
      body: { funds: [] },
    };
  }
};
