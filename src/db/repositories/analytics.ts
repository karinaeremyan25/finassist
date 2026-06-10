import { sql } from '../client.js';

/**
 * Репозиторий аналитики (P&L, недельные сводки, расходы по категориям).
 *
 * Расчётная логика P&L (SPEC 5.4) — в services/analytics.ts; здесь только
 * агрегирующие SQL-запросы, отдающие сырые суммы в копейках (bigint).
 *
 * Важно по P&L:
 * - revenue / directExpenses фильтруются по direction_id (NULL = все направления);
 * - totalOperational и totalRevenue считаются по ВСЕМ направлениям за период
 *   (нужны для расчёта доли общих операционных пропорционально выручке);
 * - accounting_type='personal' и 'tax' в P&L направления не входят.
 */

export interface PnLParams {
  directionId: string | null; // null = все направления
  dateFrom: string; // YYYY-MM-DD включительно
  dateTo: string; // YYYY-MM-DD включительно
}

export interface PnLQueryResult {
  revenueKopecks: bigint;
  directExpensesKopecks: bigint;
  totalOperationalKopecks: bigint;
  totalRevenueKopecks: bigint;
  incomeCount: number;
  expenseCount: number;
}

export interface PreviousPnL {
  revenueKopecks: bigint;
  directExpensesKopecks: bigint;
  totalOperationalKopecks: bigint;
  totalRevenueKopecks: bigint;
}

export interface WeeklyRevenueData {
  revenueKopecks: bigint;
  expensesKopecks: bigint;
  incomeCount: number;
  expenseCount: number;
}

export interface CategoryExpense {
  categoryId: string;
  categoryCode: string;
  displayName: string;
  accountingType: string;
  amountKopecks: bigint;
  transactionsCount: number;
}

interface PnLAggregateRow {
  revenue: bigint;
  direct_expenses: bigint;
  total_operational: bigint;
  total_revenue: bigint;
  income_count: string;
  expense_count: string;
}

/**
 * Возвращает агрегаты для P&L за период. directionId=null → revenue и
 * directExpenses считаются по всем направлениям.
 */
export async function getPnLData(params: PnLParams): Promise<PnLQueryResult> {
  const { directionId, dateFrom, dateTo } = params;
  const directionFilter =
    directionId === null ? sql`` : sql`AND t.direction_id = ${directionId}`;

  const rows = await sql<PnLAggregateRow[]>`
    SELECT
      -- Выручка направления (или всех, если directionId IS NULL)
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.flow_type = 'income' ${directionFilter}
      ), 0)::bigint AS revenue,

      -- Прямые расходы направления
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.flow_type = 'expense' AND c.accounting_type = 'direct' ${directionFilter}
      ), 0)::bigint AS direct_expenses,

      -- Общие операционные за период (по всем направлениям)
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.flow_type = 'expense' AND c.accounting_type = 'operational'
      ), 0)::bigint AS total_operational,

      -- Вся выручка за период (по всем направлениям) — для доли общих
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.flow_type = 'income'
      ), 0)::bigint AS total_revenue,

      COUNT(*) FILTER (
        WHERE t.flow_type = 'income' ${directionFilter}
      ) AS income_count,

      COUNT(*) FILTER (
        WHERE t.flow_type = 'expense' AND c.accounting_type = 'direct' ${directionFilter}
      ) AS expense_count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
  `;

  const row = rows[0];
  if (row === undefined) {
    return {
      revenueKopecks: 0n,
      directExpensesKopecks: 0n,
      totalOperationalKopecks: 0n,
      totalRevenueKopecks: 0n,
      incomeCount: 0,
      expenseCount: 0,
    };
  }

  return {
    revenueKopecks: row.revenue,
    directExpensesKopecks: row.direct_expenses,
    totalOperationalKopecks: row.total_operational,
    totalRevenueKopecks: row.total_revenue,
    incomeCount: Number(row.income_count),
    expenseCount: Number(row.expense_count),
  };
}

/**
 * P&L-агрегаты за предыдущий период (для сравнения). Те же поля без счётчиков.
 */
export async function getPreviousPeriodPnL(params: PnLParams): Promise<PreviousPnL> {
  const data = await getPnLData(params);
  return {
    revenueKopecks: data.revenueKopecks,
    directExpensesKopecks: data.directExpensesKopecks,
    totalOperationalKopecks: data.totalOperationalKopecks,
    totalRevenueKopecks: data.totalRevenueKopecks,
  };
}

/** Суммарная выручка и расходы за неделю (для еженедельной сводки). */
export async function getWeeklyRevenue(
  dateFrom: string,
  dateTo: string
): Promise<WeeklyRevenueData> {
  const rows = await sql<
    {
      revenue: bigint;
      expenses: bigint;
      income_count: string;
      expense_count: string;
    }[]
  >`
    SELECT
      COALESCE(SUM(amount_rub) FILTER (WHERE flow_type = 'income'), 0)::bigint AS revenue,
      COALESCE(SUM(amount_rub) FILTER (WHERE flow_type = 'expense'), 0)::bigint AS expenses,
      COUNT(*) FILTER (WHERE flow_type = 'income') AS income_count,
      COUNT(*) FILTER (WHERE flow_type = 'expense') AS expense_count
    FROM transactions
    WHERE deleted_at IS NULL
      AND occurred_at >= ${dateFrom}
      AND occurred_at <= ${dateTo}
  `;

  const row = rows[0];
  if (row === undefined) {
    return { revenueKopecks: 0n, expensesKopecks: 0n, incomeCount: 0, expenseCount: 0 };
  }

  return {
    revenueKopecks: row.revenue,
    expensesKopecks: row.expenses,
    incomeCount: Number(row.income_count),
    expenseCount: Number(row.expense_count),
  };
}

/**
 * Сумма расходов по каждой категории за период. Опционально ограничить
 * списком categoryIds (для алертов о росте конкретных категорий).
 */
export async function getCategoryExpenses(
  dateFrom: string,
  dateTo: string,
  categoryIds?: string[]
): Promise<CategoryExpense[]> {
  const categoryFilter =
    categoryIds !== undefined && categoryIds.length > 0
      ? sql`AND c.id IN ${sql(categoryIds)}`
      : sql``;

  const rows = await sql<
    {
      category_id: string;
      category_code: string;
      display_name: string;
      accounting_type: string;
      amount: bigint;
      transactions_count: string;
    }[]
  >`
    SELECT
      c.id AS category_id,
      c.code AS category_code,
      c.display_name,
      c.accounting_type,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount,
      COUNT(t.id) AS transactions_count
    FROM categories c
    JOIN transactions t
      ON t.category_id = c.id
      AND t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
    WHERE c.flow_type = 'expense'
      ${categoryFilter}
    GROUP BY c.id, c.code, c.display_name, c.accounting_type
    ORDER BY amount DESC
  `;

  return rows.map((row) => ({
    categoryId: row.category_id,
    categoryCode: row.category_code,
    displayName: row.display_name,
    accountingType: row.accounting_type,
    amountKopecks: row.amount,
    transactionsCount: Number(row.transactions_count),
  }));
}

export async function getLoanExpenseMetrics(
  dateFrom: string,
  dateTo: string
): Promise<{ loanAmountKopecks: bigint; revenueKopecks: bigint }> {
  const rows = await sql<
    { loan_amount: bigint; revenue_amount: bigint }[]
  >`
    SELECT
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.flow_type = 'expense'
          AND (
            c.code = 'exp_loan_husband'
            OR COALESCE(t.description, '') ILIKE '%кредит%'
            OR COALESCE(t.description, '') ILIKE '%loan%'
          )
      ), 0)::bigint AS loan_amount,
      COALESCE(SUM(t.amount_rub) FILTER (WHERE t.flow_type = 'income'), 0)::bigint AS revenue_amount
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
  `;

  const row = rows[0];
  return {
    loanAmountKopecks: row?.loan_amount ?? 0n,
    revenueKopecks: row?.revenue_amount ?? 0n,
  };
}

export async function getGratitudeFundMetrics(
  dateFrom: string,
  dateTo: string
): Promise<{ amountKopecks: bigint; count: number }> {
  const rows = await sql<
    { amount: bigint; count: string }[]
  >`
    SELECT
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount,
      COUNT(*) AS count
    FROM transactions t
    JOIN sources s ON s.id = t.source_id
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
      AND s.code = 'tochka'
      AND (
        COALESCE(t.description, '') ILIKE '%благодар%'
        OR COALESCE(t.description, '') ILIKE '%благотвор%'
      )
  `;

  const row = rows[0];
  return {
    amountKopecks: row?.amount ?? 0n,
    count: row ? Number(row.count) : 0,
  };
}

export async function getPayrollAndOperationalShare(
  dateFrom: string,
  dateTo: string
): Promise<{ fotAmountKopecks: bigint; revenueKopecks: bigint }> {
  const rows = await sql<
    { fot_amount: bigint; revenue_amount: bigint }[]
  >`
    SELECT
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.flow_type = 'expense'
          AND (
            c.accounting_type = 'operational'
            OR c.code = 'tax_payroll'
          )
      ), 0)::bigint AS fot_amount,
      COALESCE(SUM(t.amount_rub) FILTER (WHERE t.flow_type = 'income'), 0)::bigint AS revenue_amount
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
  `;

  const row = rows[0];
  return {
    fotAmountKopecks: row?.fot_amount ?? 0n,
    revenueKopecks: row?.revenue_amount ?? 0n,
  };
}

export interface DailyRevenueExpenseSnapshot {
  date: string;
  incomeKopecks: bigint;
  expenseKopecks: bigint;
}

export interface ExpenseCategorySummary {
  categoryId: string;
  displayName: string;
  amountKopecks: bigint;
  percentage: number;
}

export interface UnplannedExpenseRow {
  occurred_at: string;
  amount: bigint;
  description: string | null;
  category_name: string | null;
}

export async function getDailyRevenueExpenseHistory(
  dateFrom: string,
  dateTo: string
): Promise<DailyRevenueExpenseSnapshot[]> {
  const rows = await sql<
    { occurred_at: string; income: bigint; expense: bigint }[]
  >`
    SELECT
      t.occurred_at::text AS occurred_at,
      COALESCE(SUM(t.amount_rub) FILTER (WHERE t.flow_type = 'income'), 0)::bigint AS income,
      COALESCE(SUM(t.amount_rub) FILTER (WHERE t.flow_type = 'expense'), 0)::bigint AS expense
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
    GROUP BY t.occurred_at
    ORDER BY t.occurred_at ASC
  `;

  return rows.map((row) => ({
    date: row.occurred_at,
    incomeKopecks: row.income,
    expenseKopecks: row.expense,
  }));
}

export async function getTopExpenseCategories(
  dateFrom: string,
  dateTo: string,
  limit: number
): Promise<ExpenseCategorySummary[]> {
  const rows = await sql<
    { category_id: string; display_name: string; amount: bigint }[]
  >`
    SELECT
      c.id AS category_id,
      c.display_name,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
    GROUP BY c.id, c.display_name
    ORDER BY amount DESC
    LIMIT ${limit}
  `;

  const totalRows = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS total
    FROM transactions
    WHERE deleted_at IS NULL
      AND flow_type = 'expense'
      AND occurred_at >= ${dateFrom}
      AND occurred_at <= ${dateTo}
  `;
  const totalAmount = totalRows[0]?.total ?? 0n;

  return rows.map((row) => ({
    categoryId: row.category_id,
    displayName: row.display_name,
    amountKopecks: row.amount,
    percentage: totalAmount === 0n ? 0 : Number((row.amount * 10000n) / totalAmount) / 100,
  }));
}

// ── Mini App summary query ─────────────────────────────────────────────────

export interface SummaryTotalsParams {
  dateFrom: string;
  dateTo: string;
  entityId?: string | null;
  directionId?: string | null;
}

export interface SummaryTotals {
  totalIncomeKopecks: bigint;
  totalExpenseKopecks: bigint;
}

/**
 * Суммарные доходы и расходы за период с опциональной фильтрацией
 * по юрлицу и направлению. Используется в Mini App /api/analytics/summary.
 */
export async function getSummaryTotals(params: SummaryTotalsParams): Promise<SummaryTotals> {
  const { dateFrom, dateTo, entityId, directionId } = params;

  const rows = await sql<{ total_income: bigint; total_expense: bigint }[]>`
    SELECT
      COALESCE(SUM(amount_rub) FILTER (WHERE flow_type = 'income'), 0)::bigint AS total_income,
      COALESCE(SUM(amount_rub) FILTER (WHERE flow_type = 'expense'), 0)::bigint AS total_expense
    FROM transactions
    WHERE deleted_at IS NULL
      AND occurred_at >= ${dateFrom}
      AND occurred_at <= ${dateTo}
      ${entityId !== null && entityId !== undefined ? sql`AND entity_id = ${entityId}` : sql``}
      ${directionId !== null && directionId !== undefined ? sql`AND direction_id = ${directionId}` : sql``}
  `;

  const row = rows[0];
  return {
    totalIncomeKopecks: row?.total_income ?? 0n,
    totalExpenseKopecks: row?.total_expense ?? 0n,
  };
}

// ── Mini App transactions list ─────────────────────────────────────────────

export interface TransactionListParams {
  dateFrom: string;
  dateTo: string;
  entityId?: string | null;
  directionId?: string | null;
  limit: number;
  offset: number;
}

export interface TransactionListItem {
  id: string;
  occurredAt: string;
  description: string | null;
  amountRub: bigint;
  flowType: string;
  directionName: string | null;
  categoryName: string | null;
}

export interface TransactionListResult {
  items: TransactionListItem[];
  total: number;
}

/**
 * Список транзакций для Mini App с JOIN на directions и categories.
 */
export async function getTransactionList(
  params: TransactionListParams
): Promise<TransactionListResult> {
  const { dateFrom, dateTo, entityId, directionId, limit, offset } = params;
  const entityFilter =
    entityId !== null && entityId !== undefined ? sql`AND t.entity_id = ${entityId}` : sql``;
  const directionFilter =
    directionId !== null && directionId !== undefined
      ? sql`AND t.direction_id = ${directionId}`
      : sql``;

  const rows = await sql<{
    id: string;
    occurred_at: string;
    description: string | null;
    amount_rub: bigint;
    flow_type: string;
    direction_name: string | null;
    category_name: string | null;
  }[]>`
    SELECT
      t.id,
      t.occurred_at::text AS occurred_at,
      t.description,
      t.amount_rub,
      t.flow_type,
      d.display_name AS direction_name,
      c.display_name AS category_name
    FROM transactions t
    LEFT JOIN directions d ON d.id = t.direction_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
      ${entityFilter}
      ${directionFilter}
    ORDER BY t.occurred_at DESC, t.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
      ${entityFilter}
      ${directionFilter}
  `;

  const total = parseInt(countRows[0]?.cnt ?? '0', 10);

  return {
    items: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      description: row.description,
      amountRub: row.amount_rub,
      flowType: row.flow_type,
      directionName: row.direction_name,
      categoryName: row.category_name,
    })),
    total,
  };
}

// ── Grouped chart data ─────────────────────────────────────────────────────

export interface ChartDataPoint {
  label: string;
  incomeKopecks: bigint;
  expenseKopecks: bigint;
}

export async function getGroupedChartData(
  dateFrom: string,
  dateTo: string,
  groupBy: 'day' | 'week' | 'month',
  entityId?: string | null
): Promise<ChartDataPoint[]> {
  const truncFn =
    groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';

  const rows = await sql<{
    period_label: string;
    income: bigint;
    expense: bigint;
  }[]>`
    SELECT
      DATE_TRUNC(${truncFn}, t.occurred_at)::date::text AS period_label,
      COALESCE(SUM(t.amount_rub) FILTER (WHERE t.flow_type = 'income'), 0)::bigint AS income,
      COALESCE(SUM(t.amount_rub) FILTER (WHERE t.flow_type = 'expense'), 0)::bigint AS expense
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
      ${entityId !== null && entityId !== undefined ? sql`AND t.entity_id = ${entityId}` : sql``}
    GROUP BY DATE_TRUNC(${truncFn}, t.occurred_at)
    ORDER BY DATE_TRUNC(${truncFn}, t.occurred_at) ASC
  `;

  return rows.map((row) => ({
    label: row.period_label,
    incomeKopecks: row.income,
    expenseKopecks: row.expense,
  }));
}

export async function getUnplannedExpenses(
  dateFrom: string,
  dateTo: string
): Promise<UnplannedExpenseRow[]> {
  return await sql<UnplannedExpenseRow[]>`
    SELECT
      t.occurred_at::text,
      t.amount_rub AS amount,
      t.description,
      c.display_name AS category_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at <= ${dateTo}
      AND (
        COALESCE(t.description, '') ILIKE '%внепл%'
        OR COALESCE(t.description, '') ILIKE '%неплан%'
        OR COALESCE(t.description, '') ILIKE '%экстр%'
        OR COALESCE(t.description, '') ILIKE '%неожид%'
      )
    ORDER BY t.occurred_at DESC, t.amount_rub DESC
  `;
}
