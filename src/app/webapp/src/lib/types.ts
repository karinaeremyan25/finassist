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

export interface SetTxCategoryResponse {
  id: string;
  category: string;
  needs_review: boolean;
  category_overridden_at: string;
}
