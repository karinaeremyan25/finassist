import { z } from 'zod';
import { sql } from '../db/client.js';
import { getPnLData, getPreviousPeriodPnL, getWeeklyRevenue, getCategoryExpenses } from '../db/repositories/analytics.js';
import { getPreviousPeriod, getWeekPeriod, formatDateMSK } from '../utils/dates.js';
import { rubles } from '../utils/money.js';
import { childLogger } from '../utils/logger.js';
import type { PnLResult } from '../types.js';

/**
 * Сервис аналитики.
 *
 * - P&L по SPEC 5.4 — revenue/directExpenses фильтруются по direction_id,
 *   totalOperational/totalRevenue — по всему периоду (все направления).
 * - Роль не влияет на данные. Manager-фильтр — единственное исключение:
 *   если запрошено направление вне manager_directions → FORBIDDEN_DIRECTION.
 * - Все суммы в bigint (копейки).
 */

const log = childLogger({ handler: 'analytics' });

// ─────────────────────────────────────────────────────────────
// Zod-схемы
// ─────────────────────────────────────────────────────────────

const PnLInputSchema = z.object({
  directionId: z.string().uuid().nullable(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  viewerUserId: z.string().uuid(),
  viewerRole: z.enum(['owner', 'accountant', 'manager']),
});

export type PnLInput = z.input<typeof PnLInputSchema>;

const TaxBaseInputSchema = z.object({
  entityCode: z.string().min(1),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const WeeklySummaryInputSchema = z.object({
  weekEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ─────────────────────────────────────────────────────────────
// Типы для недельной сводки
// ─────────────────────────────────────────────────────────────

export interface DirectionWeeklyRevenue {
  directionId: string;
  directionCode: string;
  displayName: string;
  revenueKopecks: bigint;
  prevRevenueKopecks: bigint;
  changePercent: number | null;
}

export interface CategoryGrowth {
  categoryId: string;
  categoryCode: string;
  displayName: string;
  amountKopecks: bigint;
  avgPrevKopecks: bigint;
  growthPercent: number;
}

export interface WeeklySummaryData {
  weekDateFrom: string;
  weekDateTo: string;
  directionRevenues: DirectionWeeklyRevenue[];
  categoryGrowths: CategoryGrowth[];
  monthForecastByDirection: Array<{
    directionId: string;
    displayName: string;
    forecastKopecks: bigint;
  }>;
  totalRevenueKopecks: bigint;
  totalExpensesKopecks: bigint;
  transactionsCount: number;
}

// ─────────────────────────────────────────────────────────────
// calculatePnL
// ─────────────────────────────────────────────────────────────

/**
 * P&L по направлению или по всем направлениям за период.
 * Для manager: если directionId не в его manager_directions → FORBIDDEN_DIRECTION.
 */
export async function calculatePnL(input: PnLInput): Promise<PnLResult> {
  const parsed = PnLInputSchema.parse(input);
  const start = Date.now();

  const params = {
    directionId: parsed.directionId,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
  };

  // Текущий период
  const current = await getPnLData(params);

  // Предыдущий период (той же длины)
  const prevPeriod = getPreviousPeriod({ dateFrom: parsed.dateFrom, dateTo: parsed.dateTo });
  const previous = await getPreviousPeriodPnL({
    directionId: parsed.directionId,
    dateFrom: prevPeriod.dateFrom,
    dateTo: prevPeriod.dateTo,
  });

  // Расчёт доли операционных (SPEC 5.4)
  const operationalShare =
    current.totalRevenueKopecks === 0n
      ? 0n
      : (current.totalOperationalKopecks * current.revenueKopecks) / current.totalRevenueKopecks;

  const netProfit = current.revenueKopecks - current.directExpensesKopecks - operationalShare;

  const marginPercent =
    current.revenueKopecks === 0n
      ? null
      : Math.round((Number(netProfit) / Number(current.revenueKopecks)) * 10000) / 100;

  // Сравнение с предыдущим периодом
  const prevOperationalShare =
    previous.totalRevenueKopecks === 0n
      ? 0n
      : (previous.totalOperationalKopecks * previous.revenueKopecks) / previous.totalRevenueKopecks;
  const prevNetProfit =
    previous.revenueKopecks - previous.directExpensesKopecks - prevOperationalShare;

  const revenueChangePercent =
    previous.revenueKopecks === 0n
      ? null
      : Math.round(
          ((Number(current.revenueKopecks) - Number(previous.revenueKopecks)) /
            Number(previous.revenueKopecks)) *
            10000
        ) / 100;

  const profitChangePercent =
    prevNetProfit === 0n
      ? null
      : Math.round(
          ((Number(netProfit) - Number(prevNetProfit)) / Math.abs(Number(prevNetProfit))) * 10000
        ) / 100;

  // Загрузка метаданных направления (если задано)
  let direction: PnLResult['direction'] = null;
  if (parsed.directionId !== null) {
    const dirRows = await sql<{ id: string; code: string; display_name: string }[]>`
      SELECT id, code, display_name FROM directions WHERE id = ${parsed.directionId}
    `;
    const dir = dirRows[0];
    if (dir !== undefined) {
      direction = { id: dir.id, code: dir.code, displayName: dir.display_name };
    }
  }

  log.info(
    {
      direction_id: parsed.directionId,
      date_from: parsed.dateFrom,
      date_to: parsed.dateTo,
      viewer_role: parsed.viewerRole,
      latency_ms: Date.now() - start,
    },
    'analytics_pnl_calculated'
  );

  return {
    direction,
    period: { from: parsed.dateFrom, to: parsed.dateTo },
    revenueKopecks: current.revenueKopecks,
    directExpensesKopecks: current.directExpensesKopecks,
    operationalShareKopecks: operationalShare,
    netProfitKopecks: netProfit,
    marginPercent,
    transactionsCount: { income: current.incomeCount, expense: current.expenseCount },
    comparisonToPrevious: { revenueChangePercent, profitChangePercent },
  };
}

// ─────────────────────────────────────────────────────────────
// getTaxBase
// ─────────────────────────────────────────────────────────────

/**
 * Налоговая база по юрлицу за период (в копейках).
 * УСН 6%: SUM income. УСН 15%: SUM income − SUM expense.
 */
export async function getTaxBase(
  entityCode: string,
  dateFrom: string,
  dateTo: string
): Promise<bigint> {
  TaxBaseInputSchema.parse({ entityCode, dateFrom, dateTo });

  // Определяем режим налогообложения
  const entityRows = await sql<{ id: string; tax_regime: string | null }[]>`
    SELECT id, tax_regime FROM entities WHERE code = ${entityCode}
  `;
  const entity = entityRows[0];
  if (entity === undefined) {
    throw new Error(`getTaxBase: entity not found for code="${entityCode}"`);
  }

  if (entity.tax_regime === 'usn_6') {
    // База = весь доход
    const rows = await sql<{ base: bigint }[]>`
      SELECT COALESCE(SUM(t.amount_rub), 0)::bigint AS base
      FROM transactions t
      WHERE t.entity_id = ${entity.id}
        AND t.flow_type = 'income'
        AND t.deleted_at IS NULL
        AND t.occurred_at >= ${dateFrom}
        AND t.occurred_at <= ${dateTo}
    `;
    return rows[0]?.base ?? 0n;
  }

  if (entity.tax_regime === 'usn_15') {
    // База = доход − расход
    const rows = await sql<{ income: bigint; expense: bigint }[]>`
      SELECT
        COALESCE(SUM(amount_rub) FILTER (WHERE flow_type = 'income'), 0)::bigint AS income,
        COALESCE(SUM(amount_rub) FILTER (WHERE flow_type = 'expense'), 0)::bigint AS expense
      FROM transactions
      WHERE entity_id = ${entity.id}
        AND deleted_at IS NULL
        AND occurred_at >= ${dateFrom}
        AND occurred_at <= ${dateTo}
    `;
    const row = rows[0];
    if (row === undefined) return 0n;
    const base = row.income - row.expense;
    return base < 0n ? 0n : base;
  }

  // Для остальных режимов — доход как база
  const rows = await sql<{ base: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS base
    FROM transactions
    WHERE entity_id = ${entity.id}
      AND flow_type = 'income'
      AND deleted_at IS NULL
      AND occurred_at >= ${dateFrom}
      AND occurred_at <= ${dateTo}
  `;
  return rows[0]?.base ?? 0n;
}

// ─────────────────────────────────────────────────────────────
// getWeeklySummary
// ─────────────────────────────────────────────────────────────

/**
 * Собирает данные для еженедельной сводки.
 * Неделя: 7 дней до weekEndDate включительно.
 * Для сравнения — предыдущие 7 дней; для avg по категориям — предыдущие 4 недели.
 */
export async function getWeeklySummary(weekEndDate: string): Promise<WeeklySummaryData> {
  WeeklySummaryInputSchema.parse({ weekEndDate });

  const weekEnd = new Date(weekEndDate);
  const { dateFrom: weekFrom, dateTo: weekTo } = getWeekPeriod(weekEnd);

  // Предыдущая неделя
  const prevWeekEnd = new Date(weekEnd);
  prevWeekEnd.setDate(prevWeekEnd.getDate() - 7);
  const { dateFrom: prevWeekFrom, dateTo: prevWeekTo } = getWeekPeriod(prevWeekEnd);

  // Текущая неделя — агрегаты
  const weekData = await getWeeklyRevenue(weekFrom, weekTo);
  const prevWeekData = await getWeeklyRevenue(prevWeekFrom, prevWeekTo);

  // Выручка по направлениям за текущую и предыдущую неделю
  const directions = await sql<{ id: string; code: string; display_name: string }[]>`
    SELECT id, code, display_name FROM directions WHERE is_active = true ORDER BY display_order ASC, code ASC
  `;

  const directionRevenues: DirectionWeeklyRevenue[] = [];
  for (const dir of directions) {
    const curRows = await sql<{ revenue: bigint }[]>`
      SELECT COALESCE(SUM(amount_rub), 0)::bigint AS revenue
      FROM transactions
      WHERE direction_id = ${dir.id}
        AND flow_type = 'income'
        AND deleted_at IS NULL
        AND occurred_at >= ${weekFrom}
        AND occurred_at <= ${weekTo}
    `;
    const prevRows = await sql<{ revenue: bigint }[]>`
      SELECT COALESCE(SUM(amount_rub), 0)::bigint AS revenue
      FROM transactions
      WHERE direction_id = ${dir.id}
        AND flow_type = 'income'
        AND deleted_at IS NULL
        AND occurred_at >= ${prevWeekFrom}
        AND occurred_at <= ${prevWeekTo}
    `;
    const cur = curRows[0]?.revenue ?? 0n;
    const prev = prevRows[0]?.revenue ?? 0n;
    const changePercent =
      prev === 0n
        ? null
        : Math.round(((Number(cur) - Number(prev)) / Number(prev)) * 10000) / 100;

    directionRevenues.push({
      directionId: dir.id,
      directionCode: dir.code,
      displayName: dir.display_name,
      revenueKopecks: cur,
      prevRevenueKopecks: prev,
      changePercent,
    });
  }

  // Расходы по категориям за текущую неделю
  const currentCatExpenses = await getCategoryExpenses(weekFrom, weekTo);

  // Среднее за предыдущие 4 недели по тем же категориям
  const growthThreshold = 30; // %
  const categoryGrowths: CategoryGrowth[] = [];

  for (const cat of currentCatExpenses) {
    if (cat.amountKopecks === 0n) continue;

    // 4 недели назад
    const fourWeeksAgo = new Date(weekEnd);
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const prevMonthEnd = new Date(weekEnd);
    prevMonthEnd.setDate(prevMonthEnd.getDate() - 7);

    const prevRows = await sql<{ amount: bigint }[]>`
      SELECT COALESCE(SUM(t.amount_rub), 0)::bigint AS amount
      FROM transactions t
      WHERE t.category_id = ${cat.categoryId}
        AND t.flow_type = 'expense'
        AND t.deleted_at IS NULL
        AND t.occurred_at >= ${fourWeeksAgo.toISOString().slice(0, 10)}
        AND t.occurred_at <= ${prevMonthEnd.toISOString().slice(0, 10)}
    `;
    const totalPrev = prevRows[0]?.amount ?? 0n;
    const avgPrev = totalPrev / 4n;

    if (avgPrev > 0n) {
      const growth =
        Math.round(((Number(cat.amountKopecks) - Number(avgPrev)) / Number(avgPrev)) * 10000) /
        100;
      if (growth > growthThreshold) {
        categoryGrowths.push({
          categoryId: cat.categoryId,
          categoryCode: cat.categoryCode,
          displayName: cat.displayName,
          amountKopecks: cat.amountKopecks,
          avgPrevKopecks: avgPrev,
          growthPercent: growth,
        });
      }
    }
  }

  // Прогноз на месяц: линейный по текущей неделе
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const remainingFactor = daysInMonth / (dayOfMonth > 0 ? dayOfMonth : 1);

  const monthForecastByDirection = directionRevenues
    .filter((d) => d.revenueKopecks > 0n)
    .map((d) => ({
      directionId: d.directionId,
      displayName: d.displayName,
      forecastKopecks: BigInt(Math.round(Number(d.revenueKopecks) * remainingFactor)),
    }));

  return {
    weekDateFrom: weekFrom,
    weekDateTo: weekTo,
    directionRevenues,
    categoryGrowths,
    monthForecastByDirection,
    totalRevenueKopecks: weekData.revenueKopecks,
    totalExpensesKopecks: weekData.expensesKopecks,
    transactionsCount: weekData.incomeCount + weekData.expenseCount,
  };
}

// ─────────────────────────────────────────────────────────────
// Форматирование P&L в текст Telegram
// ─────────────────────────────────────────────────────────────

export function formatPnLMessage(pnl: PnLResult): string {
  const dirLabel = pnl.direction?.displayName ?? 'Все направления';
  const from = formatDateMSK(pnl.period.from);
  const to = formatDateMSK(pnl.period.to);

  const lines: string[] = [
    `*Отчёт: ${dirLabel}*`,
    `Период: ${from} — ${to}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `Выручка: ${rubles(pnl.revenueKopecks)}`,
    `Прямые расходы: ${rubles(pnl.directExpensesKopecks)}`,
    `Доля общих расходов: ${rubles(pnl.operationalShareKopecks)}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    `Чистая прибыль: ${rubles(pnl.netProfitKopecks)}`,
    `Маржа: ${pnl.marginPercent !== null ? `${pnl.marginPercent.toFixed(1)}%` : 'n/a'}`,
  ];

  if (pnl.comparisonToPrevious) {
    const { revenueChangePercent, profitChangePercent } = pnl.comparisonToPrevious;
    lines.push('');
    lines.push('К предыдущему периоду:');
    if (revenueChangePercent !== null) {
      const arrow = revenueChangePercent >= 0 ? '+' : '';
      lines.push(`  Выручка: ${arrow}${revenueChangePercent.toFixed(1)}%`);
    }
    if (profitChangePercent !== null) {
      const arrow = profitChangePercent >= 0 ? '+' : '';
      lines.push(`  Прибыль: ${arrow}${profitChangePercent.toFixed(1)}%`);
    }
  }

  return lines.join('\n');
}
