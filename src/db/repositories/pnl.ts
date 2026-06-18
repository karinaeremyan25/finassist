/**
 * Репозиторий P&L-аналитики (Mini App feature-spec-pnl.md).
 *
 * Реальная схема transactions:
 *   flow_type TEXT ('income'|'expense')
 *   amount_rub BIGINT (копейки)
 *   occurred_at TIMESTAMPTZ
 *   entity_id UUID
 *   source_id UUID
 *   pnl_category TEXT
 *   is_personal BOOLEAN
 *   needs_review BOOLEAN
 *   category_overridden_by UUID
 *   category_overridden_at TIMESTAMPTZ
 *   deleted_at TIMESTAMPTZ
 *
 * Entity IDs (seed):
 *   IP  = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068'
 *   OOO = 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d'
 *
 * Source code маппинг в ответе: 'tochka' → 'tochka_direct'.
 *
 * Правила дохода без займов:
 *   flow_type='income' AND (pnl_category IS DISTINCT FROM 'loan')
 *
 * Налог не хранится — считается: ROUND(income_total * 0.08).
 *
 * Все запросы строго последовательны (pgBouncer transaction mode).
 */

import { sql } from '../client.js';

// ── Константы ─────────────────────────────────────────────────────────────

export const ENTITY_IDS = {
  ip: '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068',
  ooo: 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d',
} as const;

/**
 * Допустимые значения pnl_category (бизнес + личные).
 * Используется в PATCH /api/analytics/transactions/category для валидации.
 */
export const VALID_PNL_CATEGORIES = [
  'payroll',
  'marketing',
  'loan',
  'subscriptions',
  'tax',
  'payment_commission',
  'other_business',
  'personal_food',
  'personal_shopping',
  'personal_fuel',
  'personal_restaurant',
  'personal_entertainment',
  'personal_coffee',
  'personal_other',
] as const;

export type PnlCategory = (typeof VALID_PNL_CATEGORIES)[number];

// ── Вспомогательные типы ──────────────────────────────────────────────────

export interface PnlPeriodData {
  incomeTotal: bigint;
  /** Разбивка по source code: prodamus / robokassa / tochka_direct / lava */
  incomeSources: {
    prodamus: bigint;
    robokassa: bigint;
    tochka_direct: bigint;
    lava: bigint;
  };
  /** Бизнес-расходы (is_personal=false) по категориям */
  expensesBreakdown: {
    payroll: bigint;
    marketing: bigint;
    subscriptions: bigint;
    loan: bigint;
    payment_commission: bigint;
    other_business: bigint;
  };
  /** Расчётный налог = ROUND(incomeTotal * 0.08) */
  tax: bigint;
}

// ── Внутренние raw-типы строк БД ─────────────────────────────────────────

interface IncomeSourceRow {
  source_code: string;
  amount: bigint;
}

interface ExpenseCategoryRow {
  pnl_category: string | null;
  amount: bigint;
}

interface IncomeTotalRow {
  total: bigint;
}

// ── Хелперы ───────────────────────────────────────────────────────────────

/**
 * Преобразует 'YYYY-MM' в UTC-границы месяца.
 * dateFrom: первый день (00:00:00 UTC)
 * dateTo:   первый день следующего месяца (исключительно)
 */
export function monthBoundaries(period: string): { dateFrom: string; dateTo: string } {
  const [yearStr, monthStr] = period.split('-');
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10); // 1–12

  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01T00:00:00Z`;

  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear = year + 1;
  }
  const dateTo = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`;

  return { dateFrom, dateTo };
}

/**
 * Предыдущий период в формате 'YYYY-MM'.
 */
export function prevMonth(period: string): string {
  const [yearStr, monthStr] = period.split('-');
  let year = parseInt(yearStr!, 10);
  let month = parseInt(monthStr!, 10);
  month -= 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Вычисляет процентное изменение с точностью до 1 знака.
 * null если базовое значение = 0.
 */
function deltaPct(current: bigint, previous: bigint): number | null {
  if (previous === 0n) return null;
  const raw = (Number(current - previous) / Number(previous)) * 100;
  return Math.round(raw * 10) / 10;
}

// ── getPnlForPeriod ───────────────────────────────────────────────────────

/**
 * Собирает данные P&L за один месяц для заданного набора entity_id.
 * entityIds: null = без фильтра (оба юрлица).
 * Запросы строго последовательны.
 */
export async function getPnlForPeriod(
  period: string,
  entityIds: string[] | null
): Promise<PnlPeriodData> {
  const { dateFrom, dateTo } = monthBoundaries(period);

  const entityFilter =
    entityIds !== null
      ? sql`AND t.entity_id = ANY(${entityIds})`
      : sql``;

  // 1. Общий доход без займов
  const incomeTotalRows = await sql<IncomeTotalRow[]>`
    SELECT
      COALESCE(SUM(t.amount_rub), 0)::bigint AS total
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'income'
      AND (t.pnl_category IS DISTINCT FROM 'loan')
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${entityFilter}
  `;
  const incomeTotal = incomeTotalRows[0]?.total ?? 0n;

  // 2. Разбивка дохода по источникам (source code)
  const incomeSourceRows = await sql<IncomeSourceRow[]>`
    SELECT
      s.code AS source_code,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount
    FROM transactions t
    JOIN sources s ON s.id = t.source_id
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'income'
      AND (t.pnl_category IS DISTINCT FROM 'loan')
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${entityFilter}
    GROUP BY s.code
  `;

  const prodamus = incomeSourceRows.find((r) => r.source_code === 'prodamus')?.amount ?? 0n;
  const robokassa = incomeSourceRows.find((r) => r.source_code === 'robokassa')?.amount ?? 0n;
  const tochka_direct = incomeSourceRows.find((r) => r.source_code === 'tochka')?.amount ?? 0n;
  const lava = incomeSourceRows.find((r) => r.source_code === 'lava')?.amount ?? 0n;

  // 3. Бизнес-расходы (is_personal=false) по pnl_category
  const expenseRows = await sql<ExpenseCategoryRow[]>`
    SELECT
      t.pnl_category,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND (t.is_personal = false OR t.is_personal IS NULL)
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${entityFilter}
    GROUP BY t.pnl_category
  `;

  const expenseByCategory = new Map<string, bigint>();
  for (const row of expenseRows) {
    expenseByCategory.set(row.pnl_category ?? 'other_business', row.amount);
  }

  const expensesBreakdown = {
    payroll: expenseByCategory.get('payroll') ?? 0n,
    marketing: expenseByCategory.get('marketing') ?? 0n,
    subscriptions: expenseByCategory.get('subscriptions') ?? 0n,
    loan: expenseByCategory.get('loan') ?? 0n,
    payment_commission: expenseByCategory.get('payment_commission') ?? 0n,
    other_business: expenseByCategory.get('other_business') ?? 0n,
  };

  // 4. Расчётный налог
  const tax = BigInt(Math.round(Number(incomeTotal) * 0.08));

  return {
    incomeTotal,
    incomeSources: { prodamus, robokassa, tochka_direct, lava },
    expensesBreakdown,
    tax,
  };
}

// ── getYearPnl ────────────────────────────────────────────────────────────

export interface MonthPnlRow {
  month: string; // 'YYYY-MM'
  income: bigint;
  expenses: bigint;
  profit: bigint;
  margin_pct: number;
}

export interface YearPnlResult {
  months: MonthPnlRow[];
  totals: {
    income: bigint;
    expenses: bigint;
    profit: bigint;
    margin_pct: number;
  };
}

/**
 * Годовой P&L: один SQL с GROUP BY месяц, затем считаем налог и итоги в JS.
 * entityIds: null = оба юрлица.
 */
export async function getYearPnl(year: number, entityIds: string[] | null): Promise<YearPnlResult> {
  const dateFrom = `${year}-01-01T00:00:00Z`;
  const dateTo = `${year + 1}-01-01T00:00:00Z`;

  const entityFilter =
    entityIds !== null
      ? sql`AND t.entity_id = ANY(${entityIds})`
      : sql``;

  // Доходы по месяцам (без займов)
  const incomeRows = await sql<{ month: string; amount: bigint }[]>`
    SELECT
      TO_CHAR(DATE_TRUNC('month', t.occurred_at), 'YYYY-MM') AS month,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'income'
      AND (t.pnl_category IS DISTINCT FROM 'loan')
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${entityFilter}
    GROUP BY DATE_TRUNC('month', t.occurred_at)
    ORDER BY DATE_TRUNC('month', t.occurred_at)
  `;

  // Бизнес-расходы по месяцам (is_personal=false)
  const expenseRows = await sql<{ month: string; amount: bigint }[]>`
    SELECT
      TO_CHAR(DATE_TRUNC('month', t.occurred_at), 'YYYY-MM') AS month,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND (t.is_personal = false OR t.is_personal IS NULL)
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${entityFilter}
    GROUP BY DATE_TRUNC('month', t.occurred_at)
    ORDER BY DATE_TRUNC('month', t.occurred_at)
  `;

  // Собираем помесячно
  const incomeMap = new Map<string, bigint>();
  for (const row of incomeRows) {
    incomeMap.set(row.month, row.amount);
  }

  const expenseMap = new Map<string, bigint>();
  for (const row of expenseRows) {
    expenseMap.set(row.month, row.amount);
  }

  // Генерируем все 12 месяцев (даже пустые)
  const months: MonthPnlRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const monthKey = `${year}-${String(m).padStart(2, '0')}`;
    const income = incomeMap.get(monthKey) ?? 0n;
    const businessExpenses = expenseMap.get(monthKey) ?? 0n;
    const tax = BigInt(Math.round(Number(income) * 0.08));
    const expenses = businessExpenses + tax;
    const profit = income - expenses;
    const margin_pct =
      income === 0n ? 0 : Math.round((Number(profit) / Number(income)) * 1000) / 10;
    months.push({ month: monthKey, income, expenses, profit, margin_pct });
  }

  // Годовые итоги
  let totalIncome = 0n;
  let totalExpenses = 0n;
  for (const m of months) {
    totalIncome += m.income;
    totalExpenses += m.expenses;
  }
  const totalProfit = totalIncome - totalExpenses;
  const totalMarginPct =
    totalIncome === 0n
      ? 0
      : Math.round((Number(totalProfit) / Number(totalIncome)) * 1000) / 10;

  return {
    months,
    totals: {
      income: totalIncome,
      expenses: totalExpenses,
      profit: totalProfit,
      margin_pct: totalMarginPct,
    },
  };
}

// ── getPersonalSpending ───────────────────────────────────────────────────

export interface PersonalCategoryRow {
  code: string;
  amount: bigint;
}

export interface PersonalSpendingResult {
  total: bigint;
  categories: PersonalCategoryRow[];
}

/**
 * Личные траты (is_personal=true) за месяц, сгруппированные по pnl_category.
 */
export async function getPersonalSpending(period: string): Promise<PersonalSpendingResult> {
  const { dateFrom, dateTo } = monthBoundaries(period);

  const rows = await sql<{ pnl_category: string | null; amount: bigint }[]>`
    SELECT
      t.pnl_category,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS amount
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND t.is_personal = true
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
    GROUP BY t.pnl_category
  `;

  let total = 0n;
  const categories: PersonalCategoryRow[] = [];
  for (const row of rows) {
    const code = row.pnl_category ?? 'personal_other';
    total += row.amount;
    categories.push({ code, amount: row.amount });
  }

  return { total, categories };
}

// ── updateTxCategory ──────────────────────────────────────────────────────

export interface UpdateTxCategoryResult {
  id: string;
  pnl_category: string;
  needs_review: boolean;
  category_overridden_at: string;
}

/**
 * Обновляет pnl_category транзакции и сбрасывает needs_review.
 * is_personal выставляется автоматически по префиксу 'personal_'.
 * overriddenByUserId — UUID из app_users (AppUser.id).
 */
export async function updateTxCategory(
  txId: string,
  category: string,
  overriddenByUserId: string
): Promise<UpdateTxCategoryResult | null> {
  const isPersonal = category.startsWith('personal_');

  const rows = await sql<{
    id: string;
    pnl_category: string;
    needs_review: boolean;
    category_overridden_at: string;
  }[]>`
    UPDATE transactions
    SET
      pnl_category = ${category},
      is_personal = ${isPersonal},
      needs_review = false,
      category_overridden_by = ${overriddenByUserId}::uuid,
      category_overridden_at = NOW(),
      updated_at = NOW()
    WHERE id = ${txId}::uuid
      AND deleted_at IS NULL
    RETURNING
      id,
      pnl_category,
      needs_review,
      category_overridden_at::text AS category_overridden_at
  `;

  return rows[0] ?? null;
}
