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
import { getFundBalances, getFundDistribution } from '../../db/repositories/funds.js';
import { getMiniAppFinancialOverview } from '../../services/miniApp.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';
import type { AnalyticsSummary, ChartPayload, DistributionSlice } from '../../types.js';

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

    // Запросы СТРОГО последовательно: pgBouncer (transaction mode, порт 6543) в
    // serverless с одним соединением зависает на параллельных запросах (Promise.all
    // → 504 timeout). Таблицы небольшие, последовательно — быстро.
    const totals = await getSummaryTotals({
      dateFrom: from,
      dateTo: to,
      entityId: entity_id ?? null,
      directionId: direction_id ?? null,
    });
    const fundBalances = await getFundBalances();
    const fundDistribution = await getFundDistribution();
    const loanMetrics = await getLoanExpenseMetrics(from, to);
    const gratitudeMetrics = await getGratitudeFundMetrics(from, to);
    const topCategories = await getTopExpenseCategories(from, to, 10);

    // Реальные коды фондов (spec §6.2, CLAUDE.md реальная схема):
    //   taxFund     = сумма tax_ip + tax_ooo
    //   reserveFund = сумма reserve_ip + reserve_ooo
    //   gratitudeFund = фонд gratitude
    //   creditFund    = фонд credit (+ loanMetrics для совместимости)
    const taxFund =
      (fundBalances.find((b) => b.code === 'tax_ip')?.balanceKopecks ?? 0n) +
      (fundBalances.find((b) => b.code === 'tax_ooo')?.balanceKopecks ?? 0n) +
      // Fallback на старый код 'tax' (до миграции)
      (fundBalances.find((b) => b.code === 'tax')?.balanceKopecks ?? 0n);

    const reserveFund =
      (fundBalances.find((b) => b.code === 'reserve_ip')?.balanceKopecks ?? 0n) +
      (fundBalances.find((b) => b.code === 'reserve_ooo')?.balanceKopecks ?? 0n) +
      // Fallback на старый код 'reserve' (до миграции)
      (fundBalances.find((b) => b.code === 'reserve')?.balanceKopecks ?? 0n);

    const gratitudeFund =
      (fundBalances.find((b) => b.code === 'gratitude')?.balanceKopecks ?? 0n) +
      // Fallback: из loanMetrics (старое поведение)
      (fundBalances.find((b) => b.code === 'gratitude') === undefined
        ? gratitudeMetrics.amountKopecks
        : 0n);

    const creditFund =
      (fundBalances.find((b) => b.code === 'credit')?.balanceKopecks ?? 0n) +
      // Fallback: из loanMetrics (старое поведение)
      (fundBalances.find((b) => b.code === 'credit') === undefined
        ? loanMetrics.loanAmountKopecks
        : 0n);

    // profitFund = вычисляемый остаток (totalIncome − totalExpense − taxFund − gratitudeFund − creditFund)
    // Чтобы donut-диаграмма сходилась (mini-app-design.md §6.4)
    const rawProfit =
      totals.totalIncomeKopecks - totals.totalExpenseKopecks - taxFund - gratitudeFund - creditFund;
    const profitFund = rawProfit < 0n ? 0n : rawProfit;

    // Диаграмма «Распределение выручки»: доход × плановый % каждого фонда
    // (система Карины: Благодарность 65%, Кредиты 10%, Налог 8%, Резерв 7%,
    // Земля 5% = 95%), остаток — Прибыль 5%. Доли суммируются в 100%.
    const revenue = totals.totalIncomeKopecks;
    const distribution: DistributionSlice[] = [];
    let allocated = 0n;
    for (const f of fundDistribution) {
      const amount = (revenue * BigInt(Math.round(f.percent * 100))) / 10000n;
      allocated += amount;
      distribution.push({ label: f.name, amount, percent: f.percent, kind: 'fund' });
    }
    const profitAmount = revenue > allocated ? revenue - allocated : 0n;
    const profitPercent =
      revenue > 0n ? Math.round((Number(profitAmount) / Number(revenue)) * 1000) / 10 : 0;
    distribution.push({ label: 'Прибыль', amount: profitAmount, percent: profitPercent, kind: 'profit' });

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
      distribution,
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
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    console.error(`[SUMMARY_ERR] ${err instanceof Error ? err.message : String(err)}`);
    log.error({ err, handler: 'summary', latency_ms: Date.now() - start }, 'analytics_summary_error');
    // Деградация: пустая сводка вместо 500, чтобы дашборд открылся.
    return {
      status: 200,
      body: {
        totalIncome: 0, totalExpense: 0, balance: 0,
        fundStatus: { taxFund: 0, reserveFund: 0, gratitudeFund: 0, creditFund: 0, profitFund: 0 },
        distribution: [],
        categoryBreakdown: [],
      },
    };
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
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    console.error(`[CHARTS_ERR] ${err instanceof Error ? err.message : String(err)}`);
    log.error({ err, handler: 'charts', latency_ms: Date.now() - start }, 'analytics_charts_error');
    return { status: 200, body: { labels: [], series: [], type: 'line' } };
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
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    console.error(`[INSIGHTS_ERR] ${err instanceof Error ? err.message : String(err)}`);
    log.error(
      { err, handler: 'insights', latency_ms: Date.now() - start },
      'analytics_insights_error'
    );
    return { status: 200, body: { insights: [] } };
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
          counterparty: item.counterparty,
          pnlCategory: item.pnlCategory,
          isPersonal: item.isPersonal,
          needsReview: item.needsReview,
        })),
        total: result.total,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    console.error(`[TRANSACTIONS_ERR] ${err instanceof Error ? err.message : String(err)}`);
    log.error(
      { err, handler: 'transactions', latency_ms: Date.now() - start },
      'analytics_transactions_error'
    );
    return { status: 200, body: { transactions: [], total: 0 } };
  }
};

// Keep invalidRequest available for potential future use
export { invalidRequest };
