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

// ── getIncomeBreakdown (раскрытие дохода: из чего сложилась сумма) ─────────

export interface IncomeBreakdownItem {
  id: string;
  occurredAt: string;
  amount: bigint;
  counterparty: string | null;
  description: string | null;
  txStatus: string;
}
export interface IncomeBreakdownSource {
  sourceCode: string;
  total: bigint;
  items: IncomeBreakdownItem[];
}

/**
 * Доходные операции за месяц, сгруппированные по источнику (prodamus/lava/tochka).
 * Займы исключены (как и в доходе). Для «раскрытия» суммы дохода на экране P&L.
 */
export async function getIncomeBreakdown(
  period: string,
  entityIds: string[] | null
): Promise<IncomeBreakdownSource[]> {
  const { dateFrom, dateTo } = monthBoundaries(period);
  const entityFilter = entityIds !== null ? sql`AND t.entity_id = ANY(${entityIds})` : sql``;

  const rows = await sql<{
    source_code: string;
    id: string;
    occurred_at: string;
    amount: bigint;
    counterparty: string | null;
    description: string | null;
    tx_status: string;
  }[]>`
    SELECT s.code AS source_code, t.id, t.occurred_at::text AS occurred_at,
           t.amount_rub AS amount, t.counterparty, t.description, t.tx_status
    FROM transactions t
    JOIN sources s ON s.id = t.source_id
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'income'
      AND (t.pnl_category IS DISTINCT FROM 'loan')
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${entityFilter}
    ORDER BY t.occurred_at DESC
    LIMIT 1000
  `;

  const bySource = new Map<string, IncomeBreakdownSource>();
  for (const r of rows) {
    let g = bySource.get(r.source_code);
    if (g === undefined) {
      g = { sourceCode: r.source_code, total: 0n, items: [] };
      bySource.set(r.source_code, g);
    }
    g.total += r.amount;
    g.items.push({
      id: r.id,
      occurredAt: r.occurred_at,
      amount: r.amount,
      counterparty: r.counterparty,
      description: r.description,
      txStatus: r.tx_status,
    });
  }
  return Array.from(bySource.values()).sort((a, b) => (a.total < b.total ? 1 : -1));
}

// ── getExpenseTransactions (раскрытие статьи расходов: какие транзакции) ────

export interface ExpenseTxItem {
  id: string;
  occurredAt: string;
  amount: bigint;
  counterparty: string | null;
  description: string | null;
  pnlCategory: string | null;
}

/**
 * Расходные операции одной статьи (pnl_category) за месяц — чтобы на P&L раскрыть
 * «из чего сложилась» сумма ФОТ/Маркетинг/Прочее и т.п. и переклассифицировать.
 * Категория 'other_business' включает и операции без pnl_category (NULL).
 * Для 'tax' транзакций нет (налог расчётный) — вернётся пустой список.
 */
export async function getExpenseTransactions(
  period: string,
  entityIds: string[] | null,
  category: string
): Promise<ExpenseTxItem[]> {
  const { dateFrom, dateTo } = monthBoundaries(period);
  const entityFilter = entityIds !== null ? sql`AND t.entity_id = ANY(${entityIds})` : sql``;
  // «Прочее» = явный other_business ИЛИ пустая категория.
  const categoryFilter =
    category === 'other_business'
      ? sql`AND (t.pnl_category = 'other_business' OR t.pnl_category IS NULL)`
      : sql`AND t.pnl_category = ${category}`;

  const rows = await sql<{
    id: string;
    occurred_at: string;
    amount: bigint;
    counterparty: string | null;
    description: string | null;
    pnl_category: string | null;
  }[]>`
    SELECT t.id, t.occurred_at::text AS occurred_at, t.amount_rub AS amount,
           t.counterparty, t.description, t.pnl_category
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND (t.is_personal = false OR t.is_personal IS NULL)
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${categoryFilter}
      ${entityFilter}
    ORDER BY t.amount_rub DESC
    LIMIT 1000
  `;

  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    amount: r.amount,
    counterparty: r.counterparty,
    description: r.description,
    pnlCategory: r.pnl_category,
  }));
}

// ── getInTransitTotals (US-104: деньги в пути) ────────────────────────────

export interface InTransitTotals {
  income: { total: bigint; inTransit: bigint; real: bigint };
  expenses: { total: bigint; inTransit: bigint; real: bigint };
}

/**
 * Доход/расход за месяц с выделением «в пути» (tx_status='pending').
 *   total     = все операции (любой статус)
 *   inTransit = только tx_status='pending'
 *   real      = total − inTransit (фактически проведённые, completed)
 * Налог по нетто считается отдельно в route. Займы исключаются из дохода.
 */
export async function getInTransitTotals(
  period: string,
  entityIds: string[] | null
): Promise<InTransitTotals> {
  const { dateFrom, dateTo } = monthBoundaries(period);
  const entityFilter = entityIds !== null ? sql`AND t.entity_id = ANY(${entityIds})` : sql``;

  const rows = await sql<{ flow_type: 'income' | 'expense'; total: bigint; in_transit: bigint }[]>`
    SELECT
      t.flow_type,
      COALESCE(SUM(t.amount_rub), 0)::bigint AS total,
      COALESCE(SUM(t.amount_rub) FILTER (WHERE t.tx_status = 'pending'), 0)::bigint AS in_transit
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.tx_status <> 'returned'
      AND (t.flow_type = 'expense' OR t.pnl_category IS DISTINCT FROM 'loan')
      AND t.occurred_at >= ${dateFrom}
      AND t.occurred_at < ${dateTo}
      ${entityFilter}
    GROUP BY t.flow_type
  `;

  const inc = rows.find((r) => r.flow_type === 'income');
  const exp = rows.find((r) => r.flow_type === 'expense');
  const incomeTotal = inc?.total ?? 0n;
  let incomeTransit = inc?.in_transit ?? 0n;
  const expenseTotal = exp?.total ?? 0n;
  let expenseTransit = exp?.in_transit ?? 0n;

  // Расходы/доходы «в обработке» из баланса Точки (поле Expected, лежит в
  // funds.processing_kopecks): <0 — расход в обработке, >0 — доход в обработке.
  // Это текущий снимок по счетам (не привязан к периоду) — показываем как «в пути».
  const fundFilter = entityIds !== null ? sql`AND entity_id = ANY(${entityIds})` : sql``;
  const procRows = await sql<{ out_processing: bigint; in_processing: bigint }[]>`
    SELECT
      COALESCE(SUM(-processing_kopecks) FILTER (WHERE processing_kopecks < 0), 0)::bigint AS out_processing,
      COALESCE(SUM(processing_kopecks) FILTER (WHERE processing_kopecks > 0), 0)::bigint AS in_processing
    FROM funds
    WHERE deleted_at IS NULL ${fundFilter}
  `;
  expenseTransit += procRows[0]?.out_processing ?? 0n;
  incomeTransit += procRows[0]?.in_processing ?? 0n;

  return {
    income: { total: incomeTotal, inTransit: incomeTransit, real: incomeTotal - incomeTransit },
    expenses: { total: expenseTotal, inTransit: expenseTransit, real: expenseTotal - expenseTransit },
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
