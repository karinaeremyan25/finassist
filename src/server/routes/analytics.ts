/**
 * Analytics route handlers:
 *   GET /api/analytics/summary
 *   GET /api/analytics/charts
 *   GET /api/analytics/insights
 *   GET /api/analytics/transactions
 */

import { z } from 'zod';
import * as XLSX from 'xlsx';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import {
  getSummaryTotals,
  getGroupedChartData,
  getTopExpenseCategories,
  getLoanExpenseMetrics,
  getGratitudeFundMetrics,
  getTransactionList,
  getTransactionsForExport,
  PNL_CATEGORY_LABELS,
} from '../../db/repositories/analytics.js';
import { config } from '../../config.js';
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

    // Donut «Деньги по фондам»: ФАКТИЧЕСКИЕ балансы фондов-накоплений (та же
    // система Карины: Благодарность, Кредиты, Налог, Резерв, Земля), чтобы
    // цифры на Главной совпадали со вкладкой «Фонды». Раньше здесь был план
    // (доход × %) + синтетическая «Прибыль» — это путало (Земля на Главной ≠
    // Земля в Фондах, и «Прибыль» выглядела фондом, которого нет).
    const donutCodes = new Set(fundDistribution.map((f) => f.code));
    const donutFunds = fundBalances
      .filter((b) => donutCodes.has(b.code) && b.balanceKopecks > 0n)
      .sort((a, b) => (a.balanceKopecks < b.balanceKopecks ? 1 : -1));
    const donutTotal = donutFunds.reduce((s, b) => s + b.balanceKopecks, 0n);
    const distribution: DistributionSlice[] = donutFunds.map((b) => ({
      label: b.displayName,
      amount: b.balanceKopecks,
      percent:
        donutTotal > 0n ? Math.round((Number(b.balanceKopecks) / Number(donutTotal)) * 1000) / 10 : 0,
      kind: 'fund' as const,
    }));

    // Деньги на ИП — сумма счетов с префиксом 40802 (ИП-счета Точки),
    // на ООО — счета с префиксом 40702. Префикс надёжнее, чем funds.entity_id.
    const fundsTotal = fundBalances
      .filter((b) => (b.tochkaAccountId ?? '').startsWith('40802'))
      .reduce((s, b) => s + b.balanceKopecks, 0n);
    const oooTotal = fundBalances
      .filter((b) => (b.tochkaAccountId ?? '').startsWith('40702'))
      .reduce((s, b) => s + b.balanceKopecks, 0n);

    const summary: AnalyticsSummary = {
      totalIncome: totals.totalIncomeKopecks,
      totalExpense: totals.totalExpenseKopecks,
      balance: totals.totalIncomeKopecks - totals.totalExpenseKopecks,
      fundsTotal,
      oooTotal,
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
        totalIncome: 0, totalExpense: 0, balance: 0, fundsTotal: 0, oooTotal: 0,
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
          // Знак суммы: доход +, расход − (в БД amount_rub хранится без знака).
          amount: item.flowType === 'expense' ? -item.amountRub : item.amountRub,
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

// ── GET /api/analytics/export — CSV всех операций ботом в чат ────────────────

const ExportQuerySchema = z.object({
  from: DateSchema,
  to: DateSchema,
  entity_id: z.string().uuid().optional(),
  direction_id: z.string().uuid().optional(),
});

/** Отправка файла ботом в чат пользователя (Telegram sendDocument). */
async function sendDocumentToChat(
  chatId: bigint,
  filename: string,
  buf: Buffer,
  mime: string,
  caption: string
): Promise<boolean> {
  const token = config.BOT_TOKEN;
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('chat_id', chatId.toString());
  form.append('caption', caption);
  form.append('document', blob, filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  return res.ok;
}

export const exportHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = ExportQuerySchema.safeParse(req.query);
    if (!parsed.success) return badFilter();
    const { from, to, entity_id, direction_id } = parsed.data;

    const rows = await getTransactionsForExport({
      dateFrom: from,
      dateTo: to,
      entityId: entity_id ?? null,
      directionId: direction_id ?? null,
    });

    // Сборка таблицы (массив строк). Сумма — ЧИСЛО (расход со знаком минус),
    // чтобы Excel/Numbers воспринимали её как число и считали.
    const aoa: (string | number)[][] = [
      ['Дата', 'Юрлицо', 'Направление', 'Категория', 'Тип', 'Сумма, ₽', 'Контрагент', 'Описание', 'Источник'],
    ];
    let incomeTotal = 0;
    let expenseTotal = 0;
    for (const r of rows) {
      const rub = Number(r.amountRub) / 100;
      if (r.flowType === 'income') incomeTotal += rub;
      else expenseTotal += rub;
      const category = r.isPersonal
        ? 'Личное'
        : r.flowType === 'income'
          ? (r.categoryName ?? 'Доход')
          : (r.pnlCategory ? (PNL_CATEGORY_LABELS[r.pnlCategory] ?? r.pnlCategory) : (r.categoryName ?? 'Прочее'));
      aoa.push([
        r.occurredAt.slice(0, 10),
        r.entityName ?? '',
        r.directionName ?? '',
        category,
        r.flowType === 'income' ? 'доход' : 'расход',
        r.flowType === 'expense' ? -rub : rub,
        r.counterparty ?? '',
        r.description ?? '',
        r.sourceCode ?? '',
      ]);
    }
    aoa.push([]);
    aoa.push(['ИТОГО доход', '', '', '', '', incomeTotal]);
    aoa.push(['ИТОГО расход', '', '', '', '', -expenseTotal]);
    aoa.push(['Доход − Расход', '', '', '', '', incomeTotal - expenseTotal]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Ширины колонок с запасом, чтобы суммы не липли к соседнему столбцу.
    ws['!cols'] = [
      { wch: 12 }, // Дата
      { wch: 18 }, // Юрлицо
      { wch: 22 }, // Направление
      { wch: 24 }, // Категория
      { wch: 9 },  // Тип
      { wch: 18 }, // Сумма
      { wch: 38 }, // Контрагент
      { wch: 44 }, // Описание
      { wch: 12 }, // Источник
    ];
    // Числовой формат для столбца «Сумма» (F): 4 795,00 с разделением разрядов.
    const amountCol = 5;
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
    for (let r = 1; r <= range.e.r; r++) {
      const addr = XLSX.utils.encode_cell({ c: amountCol, r });
      const cell = ws[addr];
      if (cell && typeof cell.v === 'number') {
        cell.t = 'n';
        cell.z = '#,##0.00;[Red]-#,##0.00';
      }
    }
    // Автофильтр по шапке (только по строкам данных, без итогов).
    ws['!autofilter'] = { ref: `A1:I${rows.length + 1}` };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Операции');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const filename = `finassist_${from}_${to}.xlsx`;
    const caption = `Отчёт по операциям ${from} … ${to}\nСтрок: ${rows.length}. Открой в Excel/Numbers — суммы числами, можно сортировать и складывать.`;

    const sent = await sendDocumentToChat(
      user.telegramId,
      filename,
      buf,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      caption
    );
    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'export', rows: rows.length, sent, latency_ms: Date.now() - start },
      'analytics_export_done'
    );
    if (!sent) return { status: 200, body: { ok: false, error: 'Не удалось отправить файл в чат' } };
    return { status: 200, body: { ok: true, rows: rows.length } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'export', latency_ms: Date.now() - start }, 'analytics_export_error');
    return { status: 200, body: { ok: false, error: 'Ошибка выгрузки' } };
  }
};
