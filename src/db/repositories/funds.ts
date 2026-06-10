import { sql } from '../client.js';
import { mapTransaction, type TransactionRow } from './_mappers.js';
import type { FundBalance, FundCode, Transaction } from '../../types.js';

/**
 * Репозиторий фондов.
 *
 * - Балансы считаются как SUM(amount) по fund_transactions (amount может быть
 *   отрицательным — списание).
 * - executeAllocation атомарна (sql.begin → BEGIN/COMMIT, при ошибке ROLLBACK).
 * - Все суммы — bigint (копейки RUB).
 */

/** Данные для создания одного движения по фонду. */
export interface FundTransactionCreate {
  fundId: string;
  amount: bigint; // + зачисление, − списание
  fundTransactionType: 'allocation' | 'withdrawal' | 'manual_adjust';
  sourceTransactionId?: string | null;
  occurredAt: string; // YYYY-MM-DD
  description?: string | null;
  createdBy: string;
}

/** Один элемент распределения по фонду (для executeAllocation). */
export interface AllocationItem {
  fundCode: FundCode;
  amountKopecks: bigint;
  percentage: number;
  sourceTransactionId: string;
  occurredAt: string; // YYYY-MM-DD
  description?: string | null;
}

interface FundBalanceRow {
  id: string;
  code: string;
  display_name: string;
  default_percentage: string;
  balance: bigint | null;
}

/**
 * Балансы всех фондов на дату (включительно). Если asOfDate не задан —
 * на текущий момент. Возвращает базовые балансы; tax_status (для алертов)
 * добавляется в services/funds.ts.
 */
export async function getFundBalances(asOfDate?: string): Promise<FundBalance[]> {
  const rows = await sql<FundBalanceRow[]>`
    SELECT
      f.id,
      f.code,
      f.display_name,
      f.default_percentage,
      COALESCE(SUM(ft.amount), 0)::bigint AS balance
    FROM funds f
    LEFT JOIN fund_transactions ft
      ON ft.fund_id = f.id
      ${asOfDate !== undefined ? sql`AND ft.occurred_at <= ${asOfDate}` : sql``}
    GROUP BY f.id, f.code, f.display_name, f.default_percentage, f.display_order
    ORDER BY f.display_order ASC
  `;

  return rows.map((row) => ({
    id: row.id,
    code: row.code as FundCode,
    displayName: row.display_name,
    balanceKopecks: row.balance ?? 0n,
    defaultPercentage: Number(row.default_percentage),
  }));
}

export async function createFundTransaction(data: FundTransactionCreate): Promise<void> {
  await sql`
    INSERT INTO fund_transactions (
      fund_id, amount, fund_transaction_type,
      source_transaction_id, occurred_at, description, created_by
    ) VALUES (
      ${data.fundId}, ${data.amount}, ${data.fundTransactionType},
      ${data.sourceTransactionId ?? null}, ${data.occurredAt}, ${data.description ?? null}, ${data.createdBy}
    )
  `;
}

/**
 * Атомарно создаёт несколько движений типа 'allocation'.
 * Резолвит fund_code → fund_id внутри транзакции, всё в одном BEGIN/COMMIT.
 * При любой ошибке sql.begin делает ROLLBACK.
 */
export async function executeAllocation(
  allocations: AllocationItem[],
  executedBy: string
): Promise<void> {
  if (allocations.length === 0) {
    return;
  }

  await sql.begin(async (tx) => {
    const fundRows = await tx<{ id: string; code: string }[]>`
      SELECT id, code FROM funds
    `;
    const fundIdByCode = new Map<string, string>();
    for (const f of fundRows) {
      fundIdByCode.set(f.code, f.id);
    }

    for (const item of allocations) {
      const fundId = fundIdByCode.get(item.fundCode);
      if (fundId === undefined) {
        throw new Error(`executeAllocation: unknown fund code "${item.fundCode}"`);
      }

      await tx`
        INSERT INTO fund_transactions (
          fund_id, amount, fund_transaction_type,
          source_transaction_id, occurred_at, description, created_by
        ) VALUES (
          ${fundId}, ${item.amountKopecks}, 'allocation',
          ${item.sourceTransactionId}, ${item.occurredAt},
          ${item.description ?? `Распределение ${item.percentage}%`}, ${executedBy}
        )
      `;
    }
  });
}

/**
 * Доходные транзакции, которые ещё не были распределены по фондам
 * (нет ни одной fund_transaction с этим source_transaction_id).
 */
export async function getUndistributedTransactions(): Promise<Transaction[]> {
  const rows = await sql<TransactionRow[]>`
    SELECT
      t.id, t.flow_type, t.amount, t.currency, t.amount_rub, t.fx_rate,
      t.entity_id, t.direction_id, t.category_id, t.source_id,
      t.occurred_at, t.description, t.external_id,
      t.created_by, t.verified, t.verified_by, t.verified_at,
      t.needs_classification, t.needs_owner_review, t.ai_confidence,
      t.raw_input, t.raw_ai_response, t.deleted_at, t.created_at, t.updated_at
    FROM transactions t
    WHERE t.flow_type = 'income'
      AND t.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM fund_transactions ft
        WHERE ft.source_transaction_id = t.id
      )
    ORDER BY t.occurred_at DESC, t.created_at DESC
  `;
  return rows.map(mapTransaction);
}
