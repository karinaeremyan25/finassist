/**
 * Репозиторий monthly_plans — план/факт по месяцам.
 *
 * Таблица monthly_plans:
 *   id            uuid PK
 *   year_month    text  '2026-06' UNIQUE
 *   income_min    bigint (копейки, nullable)
 *   income_avg    bigint (копейки, nullable)
 *   income_max    bigint (копейки, nullable)
 *   expense_min   bigint (копейки, nullable)
 *   expense_avg   bigint (копейки, nullable)
 *   expense_max   bigint (копейки, nullable)
 *   created_at    timestamptz
 *   updated_at    timestamptz
 *
 * Факт: SUM(amount_rub) по transactions за месяц,
 * где occurred_at IN [month-01, next-month-01) и deleted_at IS NULL.
 */

import { sql } from '../client.js';

// ── Типы ──────────────────────────────────────────────────────────────────

export interface MonthlyPlanRow {
  id: string;
  year_month: string;
  income_min: bigint | null;
  income_avg: bigint | null;
  income_max: bigint | null;
  expense_min: bigint | null;
  expense_avg: bigint | null;
  expense_max: bigint | null;
  created_at: Date;
  updated_at: Date;
}

export interface MonthlyPlan {
  id: string;
  yearMonth: string;
  incomeMin: bigint | null;
  incomeAvg: bigint | null;
  incomeMax: bigint | null;
  expenseMin: bigint | null;
  expenseAvg: bigint | null;
  expenseMax: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonthlyActuals {
  incomeActual: bigint;
  expenseActual: bigint;
}

export interface UpsertMonthlyPlanData {
  yearMonth: string;
  incomeMin?: bigint | null;
  incomeAvg?: bigint | null;
  incomeMax?: bigint | null;
  expenseMin?: bigint | null;
  expenseAvg?: bigint | null;
  expenseMax?: bigint | null;
}

// ── Mappers ────────────────────────────────────────────────────────────────

function mapMonthlyPlan(row: MonthlyPlanRow): MonthlyPlan {
  return {
    id: row.id,
    yearMonth: row.year_month,
    incomeMin: row.income_min,
    incomeAvg: row.income_avg,
    incomeMax: row.income_max,
    expenseMin: row.expense_min,
    expenseAvg: row.expense_avg,
    expenseMax: row.expense_max,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Читает строку плана по year_month ('2026-06').
 * Возвращает null, если плана нет.
 */
export async function getMonthlyPlan(yearMonth: string): Promise<MonthlyPlan | null> {
  const rows = await sql<MonthlyPlanRow[]>`
    SELECT id, year_month,
           income_min, income_avg, income_max,
           expense_min, expense_avg, expense_max,
           created_at, updated_at
    FROM monthly_plans
    WHERE year_month = ${yearMonth}
  `;
  const row = rows[0];
  return row === undefined ? null : mapMonthlyPlan(row);
}

/**
 * Считает фактические доходы и расходы за месяц.
 * Границы: occurred_at >= dateFrom AND occurred_at < dateNextMonth (ISO строки).
 * Все запросы строго последовательны (pgBouncer transaction mode).
 */
export async function getMonthActuals(
  dateFrom: string,
  dateNextMonth: string
): Promise<MonthlyActuals> {
  const incomeRows = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS total
    FROM transactions
    WHERE deleted_at IS NULL
      AND flow_type = 'income'
      AND pnl_category IS DISTINCT FROM 'loan'
      AND occurred_at >= ${dateFrom}::timestamptz
      AND occurred_at < ${dateNextMonth}::timestamptz
  `;

  const expenseRows = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS total
    FROM transactions
    WHERE deleted_at IS NULL
      AND flow_type = 'expense'
      AND occurred_at >= ${dateFrom}::timestamptz
      AND occurred_at < ${dateNextMonth}::timestamptz
  `;

  return {
    incomeActual: incomeRows[0]?.total ?? 0n,
    expenseActual: expenseRows[0]?.total ?? 0n,
  };
}

/**
 * Вставляет или обновляет план на месяц (UPSERT по year_month).
 * Обновляет только переданные поля (остальные остаются без изменений через COALESCE).
 */
export async function upsertMonthlyPlan(data: UpsertMonthlyPlanData): Promise<MonthlyPlan> {
  const rows = await sql<MonthlyPlanRow[]>`
    INSERT INTO monthly_plans (
      year_month,
      income_min, income_avg, income_max,
      expense_min, expense_avg, expense_max
    )
    VALUES (
      ${data.yearMonth},
      ${data.incomeMin ?? null},
      ${data.incomeAvg ?? null},
      ${data.incomeMax ?? null},
      ${data.expenseMin ?? null},
      ${data.expenseAvg ?? null},
      ${data.expenseMax ?? null}
    )
    ON CONFLICT (year_month) DO UPDATE
      SET income_min   = COALESCE(EXCLUDED.income_min,   monthly_plans.income_min),
          income_avg   = COALESCE(EXCLUDED.income_avg,   monthly_plans.income_avg),
          income_max   = COALESCE(EXCLUDED.income_max,   monthly_plans.income_max),
          expense_min  = COALESCE(EXCLUDED.expense_min,  monthly_plans.expense_min),
          expense_avg  = COALESCE(EXCLUDED.expense_avg,  monthly_plans.expense_avg),
          expense_max  = COALESCE(EXCLUDED.expense_max,  monthly_plans.expense_max),
          updated_at   = NOW()
    RETURNING id, year_month,
              income_min, income_avg, income_max,
              expense_min, expense_avg, expense_max,
              created_at, updated_at
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error('upsertMonthlyPlan: UPSERT did not return a row');
  }
  return mapMonthlyPlan(row);
}
