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
