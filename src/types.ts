export type Role = 'owner' | 'accountant' | 'manager';

export type FlowType = 'income' | 'expense';

export type Currency = 'RUB' | 'USD' | 'EUR' | 'KZT' | 'OTHER';

export type EntityCode = 'ip_eremyan' | 'ooo_assurgina' | 'personal';

export type DirectionCode = 'course_dpo' | 'metanoia' | 'common';

/**
 * Коды фондов.
 * Реальная схема БД (006_tochka_robokassa.sql): добавлены tax_ip, tax_ooo,
 * reserve_ip, reserve_ooo, development_ip, development_ooo, gratitude, credit, land.
 * Старые коды (tax, reserve, development) оставлены для обратной совместимости.
 */
export type FundCode =
  | 'tax' | 'reserve' | 'development' | 'personal'
  | 'tax_ip' | 'tax_ooo'
  | 'reserve_ip' | 'reserve_ooo'
  | 'development_ip' | 'development_ooo'
  | 'gratitude' | 'credit' | 'land';

export type AccountingType = 'direct' | 'operational' | 'tax' | 'personal' | 'revenue';

export interface AppUser {
  id: string;
  telegramId: bigint;
  fullName: string;
  role: Role;
  isActive: boolean;
  managerDirections?: string[]; // direction UUIDs for manager role
}

export interface Entity {
  id: string;
  code: EntityCode;
  displayName: string;
  taxRegime: string | null;
}

export interface Direction {
  id: string;
  code: DirectionCode;
  displayName: string;
  isActive: boolean;
}

export interface Category {
  id: string;
  code: string;
  displayName: string;
  flowType: FlowType;
  accountingType: AccountingType;
  parentId: string | null;
  isActive: boolean;
}

export interface Source {
  id: string;
  code: string;
  displayName: string;
  sourceType: string;
  currency: Currency;
  entityId: string | null;
}

export interface Transaction {
  id: string;
  flowType: FlowType;
  amount: bigint;
  currency: Currency;
  amountRub: bigint;
  fxRate: number | null;
  entityId: string;
  directionId: string | null;
  categoryId: string | null;
  sourceId: string;
  occurredAt: string;
  description: string | null;
  externalId: string | null;
  createdBy: string;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  needsClassification: boolean;
  needsOwnerReview: boolean;
  aiConfidence: number | null;
  rawInput: string | null;
  rawAiResponse: Record<string, unknown> | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Fund {
  id: string;
  code: FundCode;
  displayName: string;
  defaultPercentage: number;
  isRemainder: boolean;
  displayOrder: number;
}

export interface FundBalance {
  id: string;
  code: FundCode;
  displayName: string;
  balanceKopecks: bigint;
  defaultPercentage: number;
  taxStatus?: {
    nextDeadline: string;
    expectedAmountKopecks: bigint;
    shortfallKopecks: bigint;
    isAlert: boolean;
  };
}

export interface MiniAppFinancialOverview {
  period: {
    dateFrom: string;
    dateTo: string;
  };
  taxReminder: {
    nextDeadline: string | null;
    daysUntil: number | null;
    expectedTaxKopecks: bigint;
    currentTaxFundKopecks: bigint;
    shortfallKopecks: bigint;
    isUnderfunded: boolean;
    message: string;
  };
  loanBurden: {
    loanExpenseKopecks: bigint;
    revenueKopecks: bigint;
    ratioPercent: number | null;
    targetPercent: number;
    message: string;
  };
  gratitudeFund: {
    label: string;
    amountKopecks: bigint;
    count: number;
    message: string;
  };
  fundOptimization: {
    fotSharePercent: number | null;
    targetPercent: number;
    recommendation: string;
    note: string;
  };
}

export interface DailyPlanMetrics {
  minKopecks: bigint;
  avgKopecks: bigint;
  maxKopecks: bigint;
  actualKopecks: bigint;
  completionPercent: number | null;
}

export interface ExpenseCategorySummary {
  categoryId: string;
  displayName: string;
  amountKopecks: bigint;
  percentage: number;
}

export interface UnplannedExpense {
  date: string;
  amountKopecks: bigint;
  description: string | null;
  category: string | null;
}

export interface DailyFinancialReport {
  reportDate: string;
  periodLabel: string;
  income: DailyPlanMetrics;
  expenses: DailyPlanMetrics;
  totalFundBalancesKopecks: bigint;
  fundBreakdown: Array<{ code: string; displayName: string; balanceKopecks: bigint }>;
  topExpenses: ExpenseCategorySummary[];
  unplannedExpenses: UnplannedExpense[];
  loanBurden: {
    loanExpenseKopecks: bigint;
    revenueKopecks: bigint;
    ratioPercent: number | null;
    targetPercent: number;
    message: string;
  };
  gratitudeFund: {
    label: string;
    amountKopecks: bigint;
    count: number;
    message: string;
  };
  fundOptimization: {
    fotSharePercent: number | null;
    targetPercent: number;
    recommendation: string;
    note: string;
  };
  recommendations: string[];
  planNote: string;
}

export interface ClassificationResult {
  fallback: false;
  type: FlowType;
  amount: bigint;
  currency: Currency;
  amountRub: bigint;
  fxRate: number | null;
  entityCode: EntityCode;
  directionCode: DirectionCode | null;
  categoryCode: string | null;
  sourceCode: string | null;
  occurredAt: string;
  description: string | null;
  confidence: number;
  needsClarification: Array<'entity' | 'direction' | 'category' | 'source' | 'amount' | 'currency'>;
  rawTranscript: string | null;
}

export interface ClassificationFallback {
  fallback: true;
  error: string;
}

export type ClassifyResult = ClassificationResult | ClassificationFallback;

export interface BotSession {
  telegramId: bigint;
  state: string;
  context: Record<string, unknown>;
  expiresAt: Date;
}

export interface PnLResult {
  direction: { id: string; code: string; displayName: string } | null;
  period: { from: string; to: string };
  revenueKopecks: bigint;
  directExpensesKopecks: bigint;
  operationalShareKopecks: bigint;
  netProfitKopecks: bigint;
  marginPercent: number | null;
  transactionsCount: { income: number; expense: number };
  comparisonToPrevious: {
    revenueChangePercent: number | null;
    profitChangePercent: number | null;
  } | null;
}

export interface AllocationProposal {
  sourceTransactionId: string;
  amountKopecks: bigint;
  proposed: Array<{
    fundCode: FundCode;
    percentage: number;
    amountKopecks: bigint;
  }>;
}

// ── Mini App API types ────────────────────────────────────────────────────

/** Статус фондов для /api/analytics/summary (все суммы в копейках). */
export interface FundStatusPayload {
  taxFund: bigint;
  reserveFund: bigint;
  gratitudeFund: bigint;
  creditFund: bigint;
  profitFund: bigint;
}

/** Сводка аналитики (тело ответа /api/analytics/summary). */
export interface AnalyticsSummary {
  totalIncome: bigint;
  totalExpense: bigint;
  balance: bigint;
  fundStatus: FundStatusPayload;
  categoryBreakdown: Array<{ category: string; amount: bigint }>;
}

/** Серия для графика. */
export interface ChartSeries {
  name: string;
  data: bigint[];
}

/** Данные для линейного графика (тело ответа /api/analytics/charts). */
export interface ChartPayload {
  labels: string[];
  series: ChartSeries[];
  type: 'line';
}
