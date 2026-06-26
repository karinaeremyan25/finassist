/** Типы ответов API по контрактам mini-app.architector.md + бэкенд-роутам. */

export interface ApiError {
  error: { code: string; message: string };
}

export interface SessionEntity {
  id: string;
  name: string;
}

export interface SessionResponse {
  user: { telegram_id: number; name: string; role: string };
  entities: SessionEntity[];
  availableDirections: SessionEntity[];
  defaultPeriod: { from: string; to: string };
  features: string[];
}

export interface FundStatus {
  taxFund: number;
  reserveFund: number;
  gratitudeFund: number;
  creditFund: number;
  profitFund: number;
}

export interface DistributionSlice {
  label: string;
  amount: number;
  percent: number;
  kind: 'fund' | 'profit';
}

export interface AnalyticsSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  /** Сумма балансов ИП-счетов Точки (префикс 40802), копейки. */
  fundsTotal: number;
  /** Сумма балансов ООО-счетов Точки (префикс 40702), копейки. */
  oooTotal: number;
  fundStatus: FundStatus;
  distribution: DistributionSlice[];
  categoryBreakdown: Array<{ category: string; amount: number }>;
}

export interface Insight {
  title: string;
  text: string;
}

export interface InsightsResponse {
  insights: Insight[];
}

export interface TransactionItem {
  id: string;
  date: string;
  description: string;
  /** Сумма со знаком, в копейках (доход +, расход −). */
  amount: number;
  direction: string | null;
  /** Человекочитаемое имя категории (display_name или flow_type). */
  category: string;
  /** Контрагент операции. */
  counterparty: string | null;
  /** Код P&L-категории (для выпадающего списка смены категории). */
  pnlCategory: string | null;
  /** Личная операция (true) или бизнес. */
  isPersonal: boolean;
  /** Категория под вопросом — требует ручной проверки. */
  needsReview: boolean;
}

export interface TransactionsResponse {
  transactions: TransactionItem[];
  total: number;
}

export interface FundMovement {
  /** Сумма движения, в копейках (всегда положительная; знак — из kind). */
  amount: number;
  description: string;
  /** ISO-дата движения (UTC). */
  date: string;
  kind: 'in' | 'out';
}

export interface FundCard {
  id: string;
  code: string;
  name: string;
  /** Баланс фонда, в копейках. */
  balance: number;
  /** Юрлицо счёта: 'ip' | 'ooo'. */
  entity: 'ip' | 'ooo';
  /** Последние 4 цифры номера счёта (или null). */
  account: string | null;
  recentMovements: FundMovement[];
}

export interface FundsResponse {
  funds: FundCard[];
}

export interface WebAppUser {
  telegram_id: number;
  name: string;
  role: string;
  last_seen: string | null;
}

export interface UsersResponse {
  users: WebAppUser[];
}

export interface AiChatResponse {
  answer: string;
  source: string;
  timestamp: string;
}

export interface Period {
  from: string;
  to: string;
}

// ── Админка: управление пользователями (/api/admin/users) ───────────────────

export type AdminRole = 'owner' | 'accountant' | 'manager';

export interface AdminUser {
  id: string;
  username: string | null;
  fullName: string | null;
  role: AdminRole;
  isActive: boolean;
  /** bigint с бэка приходит строкой, чтобы не терять точность. */
  telegramId: string | null;
  lastSeen: string | null;
  pending: boolean;
}

export interface AdminListResponse {
  users: AdminUser[];
}

export interface AdminUserResponse {
  user: AdminUser;
}

export interface AdminDeleteResponse {
  success: boolean;
}

// ── План / Факт (/api/analytics/plan) ───────────────────────────────────────

export interface PlanLine {
  /** Копейки. null — план не задан. */
  min: number | null;
  avg: number | null;
  max: number | null;
  /** Факт за месяц, копейки. */
  actual: number;
  /** actual / min * 100, 1 знак. null если min не задан. */
  pctOfMin: number | null;
}

export interface PlanResponse {
  yearMonth: string;
  income: PlanLine;
  expense: PlanLine;
}

// ── P&L (/api/analytics/pnl, .../pnl/year, .../personal-spending) ────────────

export type PnlEntity = 'ip' | 'ooo' | 'total';

/** Источники дохода (копейки). Все поля опциональны — может не быть данных. */
export interface PnlIncomeSources {
  prodamus?: number;
  robokassa?: number;
  tochka_direct?: number;
  lava?: number;
}

/** Разбивка бизнес-расходов (копейки). Все поля опциональны. */
export interface PnlExpenseBreakdown {
  payroll?: number;
  marketing?: number;
  tax?: number;
  subscriptions?: number;
  loan?: number;
  other_business?: number;
  /** Комиссии платёжек — спека упоминает, бэк может присылать. */
  payment_commission?: number;
}

export interface PnlResponse {
  entity: PnlEntity;
  period: string; // YYYY-MM
  income: {
    /** Копейки. */
    total: number;
    sources: PnlIncomeSources;
  };
  expenses: {
    /** Копейки. */
    total: number;
    breakdown: PnlExpenseBreakdown;
  };
  /** Чистая прибыль бизнеса, копейки. */
  profit: number;
  /** Маржа, проценты (например 55.4). */
  margin_pct: number;
  vs_prev_month: {
    income_delta_pct: number;
    profit_delta_pct: number;
  };
}

export interface PnlYearMonth {
  month: string; // YYYY-MM
  income: number;
  expenses: number;
  profit: number;
  margin_pct: number;
}

export interface PnlYearResponse {
  entity: PnlEntity;
  year: number;
  months: PnlYearMonth[];
  totals: {
    income: number;
    expenses: number;
    profit: number;
    margin_pct: number;
  };
}

export interface PersonalSpendingCategory {
  code: string;
  label: string;
  /** Копейки. */
  amount: number;
  /** Доля от итога, проценты. */
  pct: number;
  vs_prev_month_pct: number;
}

export interface PersonalSpendingResponse {
  period: string; // YYYY-MM
  /** Копейки. */
  total: number;
  vs_prev_month_pct: number;
  categories: PersonalSpendingCategory[];
}

// Раскрытие дохода (из чего сложилась сумма)
export interface IncomeBreakdownItem {
  id: string;
  date: string;
  amount: number;
  counterparty: string | null;
  description: string | null;
  tx_status: string;
}
export interface IncomeBreakdownSource {
  source: string;
  total: number;
  items: IncomeBreakdownItem[];
}
export interface IncomeBreakdownResponse {
  sources: IncomeBreakdownSource[];
}

/** Одна транзакция в раскрытии статьи расходов (ФОТ/Прочее/…). */
export interface ExpenseBreakdownItem {
  id: string;
  date: string;
  amount: number;
  counterparty: string | null;
  description: string | null;
  pnl_category: string | null;
}
export interface ExpenseBreakdownResponse {
  category: string;
  items: ExpenseBreakdownItem[];
}

export interface SetTxCategoryResponse {
  id: string;
  category: string;
  needs_review: boolean;
  category_overridden_at: string;
  rule_created?: boolean;
}

// ── ФОТ (/api/employees) — SPEC v2.1 US-101 ─────────────────────────────────

export type Company = 'ip' | 'ooo';
export type EmployeeStatus = 'active' | 'on_leave' | 'dismissed';

export interface EmployeeRow {
  id: string;
  company_id: Company;
  full_name: string;
  position: string | null;
  status: EmployeeStatus;
  /** Оклад, копейки. null — не задан. */
  salary_monthly: number | null;
  /** Выплачено за текущий месяц, копейки. */
  total_paid_current: number;
  total_paid_prev: number;
  /** Оклад − выплачено за месяц. null если оклад не задан. */
  balance: number | null;
}

export interface EmployeesResponse {
  period: string;
  data: EmployeeRow[];
}

export interface EmployeeTxItem {
  id: string;
  /** Сумма со знаком, копейки. */
  amount: number;
  flow_type: 'income' | 'expense';
  pnl_category: string | null;
  description: string | null;
  counterparty: string | null;
  date_transaction: string;
  tx_status: string;
  tochka_transaction_id: string | null;
}

export interface EmployeeTransactionsResponse {
  employee: { id: string; full_name: string; position: string | null };
  data: EmployeeTxItem[];
}

export interface PayrollMonth {
  month: string;
  total: number;
}

export interface EmployeesAnalyticsResponse {
  months: PayrollMonth[];
  current_month: number;
  prev_month: number;
  delta_pct: number | null;
  avg_month: number;
}

// ── Контрагенты (/api/contractors) — US-102 ─────────────────────────────────

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'cancelled';

export interface ContractorInvoice {
  id: string;
  invoice_number: string;
  amount: number;
  description: string | null;
  due_date: string | null;
  status: InvoiceStatus;
  pdf_url: string | null;
  date_paid: string | null;
}

export interface ContractorPayment {
  id: string;
  /** Сумма со знаком: поступление +, оплата −. */
  amount: number;
  flow_type: 'income' | 'expense';
  description: string | null;
  date: string;
  tochka_transaction_id: string | null;
}

export interface ContractorRow {
  id: string;
  company_id: Company;
  name: string;
  phone: string | null;
  email: string | null;
  inn: string | null;
  bank_account: string | null;
  bik: string | null;
  contractor_type: 'individual' | 'company' | 'self_employed';
  status: 'active' | 'archived';
  total_invoiced: number;
  total_paid: number;
  balance_owed: number;
  invoices: ContractorInvoice[];
  payments: ContractorPayment[];
}

export interface ContractorsResponse {
  data: ContractorRow[];
}

export interface InvoiceGenerateResponse {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  amount: number;
  pdf_url: string | null;
}

// ── Кредиты (/api/loans) ────────────────────────────────────────────────────

export interface LoanPaymentItem {
  id: string;
  amount: number;
  description: string | null;
  date: string;
  tochka_transaction_id: string | null;
}

export interface LoanCreditorRow {
  name: string;
  total_paid: number;
  count: number;
  first_date: string;
  last_date: string;
  payments: LoanPaymentItem[];
}

export interface LoansResponse {
  total: number;
  month_total: number;
  month: string;
  data: LoanCreditorRow[];
}

// ── AI-оркестратор (/api/ai/commands) — US-105 ──────────────────────────────

export interface AiCommandIntent {
  type: 'create_invoice' | 'create_payment' | 'reclassify' | 'query' | 'unknown';
  contractor_name?: string | null;
  amount_rub?: number | null;
  description?: string | null;
  to_category?: string | null;
  keyword?: string | null;
  preview: string;
  needs_clarification?: boolean;
}

export interface AiCommandResponse {
  id: string;
  status: 'pending' | 'needs_clarification' | 'failed';
  ai_response: AiCommandIntent;
  needs_approval: boolean;
}

export interface AiCommandApproveResponse {
  status: 'executed' | 'failed' | 'rejected';
  result?: Record<string, unknown>;
}

// Единый AI-ассистент (наставник + оркестратор): ответ ИЛИ действие.
export interface AiAssistantAnswer {
  kind: 'answer';
  answer: string;
  source?: string | null;
}
export interface AiAssistantAction {
  kind: 'action';
  id: string;
  command_type: string;
  intent: AiCommandIntent;
  needs_approval: boolean;
}
export type AiAssistantResponse = AiAssistantAnswer | AiAssistantAction;

export interface TranscribeResponse {
  text?: string;
  ok?: boolean;
  error?: string;
}

// Импорт операций со скриншота карты (карта Лилианы и др.)
export interface ImportedTxItem {
  date: string;
  amount_rub: number;
  direction: 'in' | 'out';
  counterparty: string;
  description: string | null;
}
export interface ImportImageResponse {
  ok: boolean;
  transactions?: ImportedTxItem[];
  error?: string;
}
export interface ImportConfirmResponse {
  ok: boolean;
  created?: number;
  skipped?: number;
  payroll?: number;
  total?: number; // копейки
  error?: string;
}

// ── Деньги в пути (/api/analytics/pnl/in-transit) — US-104 ───────────────────

export interface InTransitResponse {
  entity: PnlEntity;
  period: string;
  income: { total: number; in_transit: number; real_income: number };
  expenses: { total: number; in_transit: number; real_expenses: number };
  tax_net: number;
}
