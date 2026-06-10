/**
 * Analytics route handlers:
 *   GET /api/analytics/summary
 *   GET /api/analytics/charts
 *   GET /api/analytics/insights
 *   GET /api/analytics/transactions
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import {
  getSummaryTotals,
  getGroupedChartData,
  getTopExpenseCategories,
  getLoanExpenseMetrics,
  getGratitudeFundMetrics,
  getTransactionList,
} from '../../db/repositories/analytics.js';
import { getFundBalances } from '../../db/repositories/funds.js';
import { getMiniAppFinancialOverview } from '../../services/miniApp.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';
import type { AnalyticsSummary, ChartPayload } from '../../types.js';

const log = childLogger({ handler: 'analytics' });

// ── Shared validation schemas ──────────────────────────────────────────────

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format YYYY-MM-DD');

const SummaryQuerySchema = z.object({
  from: DateSchema,
  to: DateSchema,
  entity_id: z.string().uuid().optional(),
  direction_id: z.string().uuid().optional(),
});

const ChartsQuerySchema = z.object({
  from: DateSchema,
  to: DateSchema,
  entity_id: z.string().uuid().optional(),
  group_by: z.enum(['day', 'week', 'month']).default('day'),
});

const InsightsQuerySchema = z.object({
  from: DateSchema,
  to: DateSchema,
  entity_id: z.string().uuid().optional(),
});

const TransactionsQuerySchema = z.object({
  from: DateSchema,
  to: DateSchema,
  entity_id: z.string().uuid().optional(),
  direction_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Helper: bad filter response ────────────────────────────────────────────

function badFilter(message = 'Неверный фильтр'): ApiResponse {
  return {
    status: 400,
    body: { error: { code: 'bad_filter', message } },
  };
}

function invalidRequest(message: string): ApiResponse {
  return {
    status: 400,
    body: { error: { code: 'invalid_request', message } },
  };
}

// ── GET /api/analytics/summary ─────────────────────────────────────────────

export const summaryHandler: ApiHandler = async (req) => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = SummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return badFilter();
    }
    const { from, to, entity_id, direction_id } = parsed.data;

    const [totals, fundBalances, loanMetrics, gratitudeMetrics, topCategories] = await Promise.all([
      getSummaryTotals({
        dateFrom: from,
        dateTo: to,
        entityId: entity_id ?? null,
        directionId: direction_id ?? null,
      }),
      getFundBalances(),
      getLoanExpenseMetrics(from, to),
      getGratitudeFundMetrics(from, to),
      getTopExpenseCategories(from, to, 10),
    ]);

    const taxFund = fundBalances.find((b) => b.code === 'tax')?.balanceKopecks ?? 0n;
    const reserveFund = fundBalances.find((b) => b.code === 'reserve')?.balanceKopecks ?? 0n;
    const creditFund = loanMetrics.loanAmountKopecks;
    const gratitudeFund = gratitudeMetrics.amountKopecks;

    // profitFund = вычисляемый остаток (totalIncome − totalExpense − taxFund − gratitudeFund − creditFund)
    // Чтобы donut-диаграмма сходилась (mini-app-design.md §6.4)
    const rawProfit =
      totals.totalIncomeKopecks - totals.totalExpenseKopecks - taxFund - gratitudeFund - creditFund;
    const profitFund = rawProfit < 0n ? 0n : rawProfit;

    const summary: AnalyticsSummary = {
      totalIncome: totals.totalIncomeKopecks,
      totalExpense: totals.totalExpenseKopecks,
      balance: totals.totalIncomeKopecks - totals.totalExpenseKopecks,
      fundStatus: {
        taxFund,
        reserveFund,
        gratitudeFund,
        creditFund,
        profitFund,
      },
      categoryBreakdown: topCategories.map((c) => ({
        category: c.displayName,
        amount: c.amountKopecks,
      })),
    };

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'summary',
        latency_ms: Date.now() - start,
      },
      'analytics_summary_ok'
    );

    return { status: 200, body: summary };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse();
    log.error({ err, handler: 'summary', latency_ms: Date.now() - start }, 'analytics_summary_error');
    throw err;
  }
};

// ── GET /api/analytics/charts ──────────────────────────────────────────────

export const chartsHandler: ApiHandler = async (req) => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = ChartsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return badFilter();
    }
    const { from, to, entity_id, group_by } = parsed.data;

    const points = await getGroupedChartData(from, to, group_by, entity_id ?? null);

    // Format labels: YYYY-MM-DD → DD.MM
    const labels = points.map((p) => {
      const d = new Date(p.label + 'T00:00:00Z');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `${dd}.${mm}`;
    });

    const incomeData = points.map((p) => p.incomeKopecks);
    const expenseData = points.map((p) => p.expenseKopecks);

    const payload: ChartPayload = {
      labels,
      series: [
        { name: 'Доход', data: incomeData },
        { name: 'Расход', data: expenseData },
      ],
      type: 'line',
    };

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'charts',
        latency_ms: Date.now() - start,
      },
      'analytics_charts_ok'
    );

    return { status: 200, body: payload };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse();
    log.error({ err, handler: 'charts', latency_ms: Date.now() - start }, 'analytics_charts_error');
    throw err;
  }
};

// ── GET /api/analytics/insights ───────────────────────────────────────────

export const insightsHandler: ApiHandler = async (req) => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = InsightsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return badFilter();
    }

    // Build insights from existing metrics — no Anthropic calls here
    const overview = await getMiniAppFinancialOverview();

    const insights: Array<{ title: string; text: string }> = [];

    // Tax fund insight
    if (overview.taxReminder.message) {
      insights.push({
        title: 'Налоговый фонд',
        text: overview.taxReminder.message,
      });
    }

    // Loan burden insight
    if (overview.loanBurden.message) {
      insights.push({
        title: 'Кредитная нагрузка',
        text: overview.loanBurden.message,
      });
    }

    // Gratitude fund insight
    if (overview.gratitudeFund.message) {
      insights.push({
        title: 'Фонд благодарности',
        text: overview.gratitudeFund.message,
      });
    }

    // FOT optimization insight
    if (overview.fundOptimization.recommendation) {
      insights.push({
        title: 'Оптимизация ФОТ',
        text: overview.fundOptimization.recommendation,
      });
    }

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'insights',
        latency_ms: Date.now() - start,
      },
      'analytics_insights_ok'
    );

    return { status: 200, body: { insights } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse();
    log.error(
      { err, handler: 'insights', latency_ms: Date.now() - start },
      'analytics_insights_error'
    );
    throw err;
  }
};

// ── GET /api/analytics/transactions ───────────────────────────────────────

export const transactionsHandler: ApiHandler = async (req) => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = TransactionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return badFilter();
    }
    const { from, to, entity_id, direction_id, limit, offset } = parsed.data;

    const result = await getTransactionList({
      dateFrom: from,
      dateTo: to,
      entityId: entity_id ?? null,
      directionId: direction_id ?? null,
      limit,
      offset,
    });

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'transactions',
        latency_ms: Date.now() - start,
      },
      'analytics_transactions_ok'
    );

    return {
      status: 200,
      body: {
        transactions: result.items.map((item) => ({
          id: item.id,
          date: item.occurredAt,
          description: item.description,
          amount: item.amountRub,
          direction: item.directionName,
          category: item.categoryName ?? item.flowType,
        })),
        total: result.total,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse();
    log.error(
      { err, handler: 'transactions', latency_ms: Date.now() - start },
      'analytics_transactions_error'
    );
    throw err;
  }
};

// Keep invalidRequest available for potential future use
export { invalidRequest };
