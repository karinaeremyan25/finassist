/** Экран Dashboard (§5/§6/§7): баланс, KPI, donut, инсайты, операции. */

import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, TrendingUp, Gem } from 'lucide-react';
import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { Donut } from '../components/Donut';
import { PlanProgress } from '../components/PlanProgress';
import { PersonalSpendCard } from '../components/PersonalSpendCard';
import { TransactionList } from '../components/TransactionList';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { useFilters } from '../state/FilterContext';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles } from '../lib/money';
import { currentMonthYm, formatMonthLabel, formatYmLabel } from '../lib/dates';

export function Dashboard() {
  const { period, entity_id, direction_id } = useFilters();
  const filters = { entity_id, direction_id };

  const summary = useAsync(
    () => api.summary(period, filters),
    [period.from, period.to, entity_id, direction_id]
  );
  const insights = useAsync(
    () => api.insights(period, filters),
    [period.from, period.to, entity_id, direction_id]
  );
  const txs = useAsync(
    () => api.transactions(period, filters, 5, 0),
    [period.from, period.to, entity_id, direction_id]
  );
  // План — всегда по текущему месяцу МСК (не зависит от выбранного периода).
  const planMonth = currentMonthYm();
  const plan = useAsync(() => api.plan(planMonth), [planMonth]);

  // Признак «нет данных за период по выбранному юрлицу/направлению».
  const summaryEmpty =
    summary.status === 'success' &&
    summary.data !== null &&
    summary.data.totalIncome === 0 &&
    summary.data.totalExpense === 0;
  const hasFilter = entity_id !== null || direction_id !== null;

  return (
    <>
      <Header />

      {/* Карточка баланса + KPI */}
      <section className="px-4 -mt-2">
        {summary.status === 'loading' ? (
          <BalanceSkeleton />
        ) : summary.status === 'error' ? (
          <div className="rounded-lg bg-surface-2 p-1">
            <ErrorState message={summary.error ?? undefined} onRetry={summary.reload} />
          </div>
        ) : summary.data ? (
          <BalanceBlock data={summary.data} />
        ) : null}
      </section>

      {/* Пусто по выбранному юрлицу/направлению за период */}
      {summaryEmpty ? (
        <section className="mt-4 px-4">
          <div className="rounded-lg bg-surface-2 p-1">
            <EmptyState
              title="Нет данных за период"
              hint={
                hasFilter
                  ? 'По выбранному юрлицу/направлению за этот период операций нет. Измените фильтр или период.'
                  : 'За выбранный период операций нет. Добавьте выписку или выберите другой период.'
              }
            />
          </div>
        </section>
      ) : null}

      {/* План на месяц */}
      <section className="mt-6 px-4">
        <SectionHeader
          title="План на месяц"
          right={<span className="num">{formatYmLabel(planMonth)}</span>}
        />
        {plan.status === 'loading' ? (
          <Skeleton className="h-28 w-full rounded-md" />
        ) : plan.status === 'error' ? (
          <ErrorState message={plan.error ?? undefined} onRetry={plan.reload} />
        ) : plan.data ? (
          <PlanProgress data={plan.data} />
        ) : null}
      </section>

      {/* Donut */}
      <section className="mt-6 px-4">
        <SectionHeader
          title="Распределение"
          right={<span className="num">{formatMonthLabel(period.from)}</span>}
        />
        {summary.status === 'loading' ? (
          <div className="flex flex-col items-center gap-4 py-4">
            <Skeleton className="h-[176px] w-[176px] rounded-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : summary.status === 'success' && summary.data ? (
          summary.data.totalIncome > 0 ? (
            <Donut summary={summary.data} />
          ) : (
            <EmptyState hint="Нет выручки за период — диаграмма скрыта." />
          )
        ) : null}
      </section>

      {/* Личные траты собственника */}
      <section className="mt-6 px-4">
        <PersonalSpendCard />
      </section>

      {/* Инсайты */}
      <section className="mt-6 px-4">
        <SectionHeader title="Инсайты" />
        {insights.status === 'loading' ? (
          <Skeleton className="h-20 w-full" />
        ) : insights.status === 'error' ? (
          <ErrorState message={insights.error ?? undefined} onRetry={insights.reload} />
        ) : insights.data && insights.data.insights.length > 0 ? (
          <div className="flex flex-col gap-2">
            {insights.data.insights.map((ins, i) => (
              <div key={i} className="rounded-md bg-surface-2 p-4">
                <div className="mb-1 flex items-center gap-2">
                  <Gem size={16} strokeWidth={2} className="shrink-0 text-accent" />
                  <h3 className="text-[15px] font-semibold text-ink">{ins.title}</h3>
                </div>
                <p className="text-[13px] leading-[18px] text-ink-muted">{ins.text}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="Пока нет инсайтов" hint="Появятся при накоплении данных." />
        )}
      </section>

      {/* Последние операции */}
      <section className="mt-6 px-4">
        <SectionHeader
          title="Последние операции"
          right={
            <Link to="/transactions" className="text-accent">
              Все →
            </Link>
          }
        />
        {txs.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : txs.status === 'error' ? (
          <ErrorState message={txs.error ?? undefined} onRetry={txs.reload} />
        ) : txs.data && txs.data.transactions.length > 0 ? (
          <TransactionList transactions={txs.data.transactions} />
        ) : (
          <EmptyState />
        )}
      </section>
    </>
  );
}

function BalanceBlock({ data }: { data: import('../lib/types').AnalyticsSummary }) {
  return (
    <>
      <div
        className="rounded-lg p-5 shadow-elev-2"
        style={{ background: 'var(--grad-balance)' }}
      >
        <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          Общий баланс
        </p>
        <p className="num mt-1 text-[34px] font-bold leading-[40px] text-ink">
          {rubles(data.balance)}
        </p>
        <p className="mt-2 flex items-center gap-1 text-[13px]" style={{ color: 'var(--income)' }}>
          <TrendingUp size={16} strokeWidth={2} />
          <span className="num">Доход — Расход за период</span>
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <KpiCard
          label="Доходы"
          value={data.totalIncome}
          tone="income"
        />
        <KpiCard
          label="Расходы"
          value={data.totalExpense}
          tone="expense"
        />
      </div>
    </>
  );
}

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'income' | 'expense';
}) {
  const Icon = tone === 'income' ? ArrowDownLeft : ArrowUpRight;
  const color = tone === 'income' ? 'var(--income)' : 'var(--expense)';
  const sign = tone === 'income' ? '+' : '−';
  return (
    <div className="rounded-md bg-surface-2 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-pill"
          style={{ background: 'rgba(255,255,255,0.06)', color }}
          aria-hidden="true"
        >
          <Icon size={16} strokeWidth={2} />
        </span>
        <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          {label}
        </span>
      </div>
      <p className="num text-[17px] font-semibold leading-tight" style={{ color }}>
        {sign}
        {rubles(value)}
      </p>
    </div>
  );
}

function BalanceSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-32 w-full rounded-lg" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
