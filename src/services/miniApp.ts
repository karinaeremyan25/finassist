import { getAllFundBalances } from './funds.js';
import { getTaxBase } from './analytics.js';
import { getSetting } from '../db/repositories/settings.js';
import {
  getDailyRevenueExpenseHistory,
  getGratitudeFundMetrics,
  getLoanExpenseMetrics,
  getPayrollAndOperationalShare,
  getTopExpenseCategories,
  getUnplannedExpenses,
} from '../db/repositories/analytics.js';
import { getNextTaxDeadline, USN_IP_DEADLINES, daysUntil, getYTDPeriod, formatDateMSK, todayMSK } from '../utils/dates.js';
import { rubles } from '../utils/money.js';
import { childLogger } from '../utils/logger.js';
import type { DailyFinancialReport, DailyPlanMetrics, MiniAppFinancialOverview } from '../types.js';

const log = childLogger({ handler: 'miniApp' });
const DEFAULT_LOAN_TARGET_PERCENT = 10;
const DEFAULT_FOT_TARGET_PERCENT = 30;

async function getLoanTargetPercent(): Promise<number> {
  // value = TEXT в реальной схеме settings
  const raw = await getSetting('loan_expense_target_percent');
  if (raw !== null) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) {
      return parsed;
    }
  }
  return DEFAULT_LOAN_TARGET_PERCENT;
}

async function formatTaxReminder(): Promise<MiniAppFinancialOverview['taxReminder']> {
  const nextDeadline = getNextTaxDeadline(USN_IP_DEADLINES);
  if (nextDeadline === null) {
    return {
      nextDeadline: null,
      daysUntil: null,
      expectedTaxKopecks: 0n,
      currentTaxFundKopecks: 0n,
      shortfallKopecks: 0n,
      isUnderfunded: false,
      message: 'Не удалось определить ближайший срок уплаты налогов. Проверьте настройки календаря.',
    };
  }

  const yearStart = `${nextDeadline.date.getFullYear()}-01-01`;
  const quarterEnd = nextDeadline.date.toISOString().slice(0, 10);
  const taxBase = await getTaxBase('ip_eremyan', yearStart, quarterEnd);
  const expectedTax = (taxBase * 6n) / 100n;
  const balances = await getAllFundBalances();
  const taxFund = balances.find((b) => b.code === 'tax');
  const taxBalance = taxFund?.balanceKopecks ?? 0n;
  const shortfall = expectedTax > taxBalance ? expectedTax - taxBalance : 0n;
  const days = daysUntil(nextDeadline.date);
  const message = shortfall > 0n
    ? `Налоговый фонд недостаточен: нужно пополнить ${rubles(shortfall)} до дедлайна ${formatDateMSK(nextDeadline.date)}.`
    : `Налоговый фонд покрывает ожидаемые налоги до ${formatDateMSK(nextDeadline.date)}.`;

  return {
    nextDeadline: formatDateMSK(nextDeadline.date),
    daysUntil: days,
    expectedTaxKopecks: expectedTax,
    currentTaxFundKopecks: taxBalance,
    shortfallKopecks: shortfall,
    isUnderfunded: shortfall > 0n,
    message,
  };
}

export async function getMiniAppFinancialOverview(): Promise<MiniAppFinancialOverview> {
  const period = getYTDPeriod();
  const taxReminder = await formatTaxReminder();
  const loanTargetPercent = await getLoanTargetPercent();

  const loanMetrics = await getLoanExpenseMetrics(period.dateFrom, period.dateTo);
  const loanRatio =
    loanMetrics.revenueKopecks === 0n
      ? null
      : Math.round((Number(loanMetrics.loanAmountKopecks) / Number(loanMetrics.revenueKopecks)) * 10000) / 100;
  const loanMessage = loanRatio === null
    ? 'Нет доходов за период. Сначала загрузите или синхронизируйте выручку проекта.'
    : loanRatio >= loanTargetPercent
    ? `Ежегодные кредитные выплаты составляют ${loanRatio.toFixed(1)}% от доходов — это минимум по договорённости. Следите за этой статьёй как за обязательной нагрузкой.`
    : `Кредитный поток составляет ${loanRatio.toFixed(1)}% от выручки, а целевой минимум — ${loanTargetPercent}%. Проверьте, что все выплаты мужа учтены.`;

  const gratitudeMetrics = await getGratitudeFundMetrics(period.dateFrom, period.dateTo);
  const gratitudeMessage = gratitudeMetrics.count > 0
    ? `В Точке найдены операции по фонду «благодарность»: ${rubles(gratitudeMetrics.amountKopecks)} за год.`
    : 'Фонд «благодарность» в Точке пока не обнаружен в операциях. Следите за тегом в описании транзакций.';

  const share = await getPayrollAndOperationalShare(period.dateFrom, period.dateTo);
  const fotRatio = share.revenueKopecks === 0n
    ? null
    : Math.round((Number(share.fotAmountKopecks) / Number(share.revenueKopecks)) * 10000) / 100;
  const fotRecommendation = fotRatio === null
    ? 'Недостаточно данных для оценки ФОТ. Убедитесь, что в бюджет входят зарплаты и налоги на ФОТ.'
    : fotRatio > DEFAULT_FOT_TARGET_PERCENT
    ? `Показатель ФОТ + налоговые расходы примерно ${fotRatio.toFixed(1)}% от выручки. Цель — не выше ${DEFAULT_FOT_TARGET_PERCENT}%. Оптимизируйте структуру фонда ЗП и роль «благодарность».`
    : `ФОТ + налоговые расходы держатся на уровне ${fotRatio.toFixed(1)}% от выручки. Это хорошая база, но проверяйте детали по зарплатной ведомости.`;

  const fundOptimizationNote =
    'В банке Точка фонд оплаты труда/благодарности лучше маркировать как «благодарность». Используйте отдельную категорию для зарплат и отдельную категорию/описание для кредитов мужа.';

  return {
    period,
    taxReminder,
    loanBurden: {
      loanExpenseKopecks: loanMetrics.loanAmountKopecks,
      revenueKopecks: loanMetrics.revenueKopecks,
      ratioPercent: loanRatio,
      targetPercent: loanTargetPercent,
      message: loanMessage,
    },
    gratitudeFund: {
      label: 'благодарность',
      amountKopecks: gratitudeMetrics.amountKopecks,
      count: gratitudeMetrics.count,
      message: gratitudeMessage,
    },
    fundOptimization: {
      fotSharePercent: fotRatio,
      targetPercent: DEFAULT_FOT_TARGET_PERCENT,
      recommendation: fotRecommendation,
      note: fundOptimizationNote,
    },
  };
}

function computeDailyPlanMetrics(
  history: Array<{ amountKopecks: bigint }>,
  actual: bigint
): DailyPlanMetrics {
  if (history.length === 0) {
    return {
      minKopecks: 0n,
      avgKopecks: 0n,
      maxKopecks: 0n,
      actualKopecks: actual,
      completionPercent: null,
    };
  }

  const amounts = history.map((row) => row.amountKopecks);
  const first = amounts[0] ?? 0n;
  const minKopecks = amounts.reduce((acc, cur) => (cur < acc ? cur : acc), first);
  const maxKopecks = amounts.reduce((acc, cur) => (cur > acc ? cur : acc), first);
  const sum = amounts.reduce((acc, cur) => acc + cur, 0n);
  const avgKopecks = BigInt(Math.round(Number(sum) / history.length));

  const completionPercent = minKopecks === 0n
    ? null
    : Math.round((Number(actual) / Number(minKopecks)) * 10000) / 100;

  return {
    minKopecks,
    avgKopecks,
    maxKopecks,
    actualKopecks: actual,
    completionPercent,
  };
}

function buildRecommendations(report: DailyFinancialReport): string[] {
  const recs: string[] = [];

  if (report.loanBurden?.ratioPercent !== undefined && report.loanBurden.ratioPercent !== null) {
    if (report.loanBurden.ratioPercent > report.loanBurden.targetPercent) {
      recs.push('Контроль кредитных выплат: выделяйте минимум 10% дохода на кредит мужа и отслеживайте их как обязательную нагрузку.');
    }
  }

  if (report.fundOptimization.fotSharePercent !== null && report.fundOptimization.fotSharePercent > report.fundOptimization.targetPercent) {
    recs.push('Оптимизируйте ФОТ: снижайте фиксированную часть, переходите на KPI/процент и сохраняйте фонд «благодарность» отдельно от операционного бюджета.');
  }

  if (report.unplannedExpenses.length > 0) {
    recs.push('Проверьте внеплановые расходы и назначьте им категории «резерв» или «непредвиденные», чтобы они не портили план бюджета.');
  }

  if (report.topExpenses.length > 0 && (report.topExpenses[0]?.percentage ?? 0) > 20) {
    recs.push('Топ расходов составляет более 20% бюджета — найдите, какие статьи можно оптимизировать или перевести в развитие/маркетинг.');
  }

  return recs.length > 0 ? recs : ['Расходы в пределах допустимого, продолжайте мониторить ежедневный баланс.'];
}

export async function generateDailyFinancialReport(reportDate?: string): Promise<DailyFinancialReport> {
  const date = reportDate ?? todayMSK();
  const periodStart = date;
  const periodEnd = date;
  const historyFrom = `${new Date(new Date(`${date}T00:00:00Z`).getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)}`;

  const history = await getDailyRevenueExpenseHistory(historyFrom, date);
  const todaySnapshot = history.find((item) => item.date === date) ?? {
    date,
    incomeKopecks: 0n,
    expenseKopecks: 0n,
  };

  const incomeHistory = history.map((row) => ({ amountKopecks: row.incomeKopecks }));
  const expenseHistory = history.map((row) => ({ amountKopecks: row.expenseKopecks }));

  const topExpenses = await getTopExpenseCategories(periodStart, periodEnd, 5);
  const unplannedExpensesRows = await getUnplannedExpenses(periodStart, periodEnd);
  const fundBalances = await getAllFundBalances();

  const totalFundBalances = fundBalances.reduce((sum, item) => sum + item.balanceKopecks, 0n);
  const fundBreakdown = fundBalances.map((item) => ({
    code: item.code,
    displayName: item.displayName,
    balanceKopecks: item.balanceKopecks,
  }));

  const overview = await getMiniAppFinancialOverview();
  const incomeMetrics = computeDailyPlanMetrics(incomeHistory, todaySnapshot.incomeKopecks);
  const expenseMetrics = computeDailyPlanMetrics(expenseHistory, todaySnapshot.expenseKopecks);

  const report: DailyFinancialReport = {
    reportDate: date,
    periodLabel: `День ${date}`,
    income: incomeMetrics,
    expenses: expenseMetrics,
    totalFundBalancesKopecks: totalFundBalances,
    fundBreakdown,
    topExpenses,
    unplannedExpenses: unplannedExpensesRows.map((row) => ({
      date: row.occurred_at,
      amountKopecks: row.amount,
      description: row.description,
      category: row.category_name,
    })),
    loanBurden: overview.loanBurden,
    gratitudeFund: overview.gratitudeFund,
    fundOptimization: overview.fundOptimization,
    recommendations: [],
    planNote: 'План минимум/средний/максимум построен по дневной истории за последний месяц.',
  };

  report.recommendations = buildRecommendations(report);

  return report;
}
