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

export interface AnalyticsSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  fundStatus: FundStatus;
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
  category: string;
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
