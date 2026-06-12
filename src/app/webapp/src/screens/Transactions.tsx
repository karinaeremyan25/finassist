/** Экран Transactions (§9): список операций + фильтры период/юрлицо/направление. */

import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { TransactionList } from '../components/TransactionList';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { FilterBar } from '../components/FilterBar';
import { useApp, useFilters } from '../state/FilterContext';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles } from '../lib/money';

export function Transactions() {
  const { period, entity_id, direction_id } = useFilters();
  const { entities, directions } = useApp();
  const filters = { entity_id, direction_id };

  const summary = useAsync(
    () => api.summary(period, filters),
    [period.from, period.to, entity_id, direction_id]
  );
  const txs = useAsync(
    () => api.transactions(period, filters, 100, 0),
    [period.from, period.to, entity_id, direction_id]
  );

  return (
    <>
      <Header />

      <section className="px-4 -mt-2">
        <h1 className="mb-3 text-[22px] font-semibold text-ink">Отчёты</h1>
        <FilterBar entities={entities} directions={directions} />
      </section>

      {/* Сводка периода */}
      <section className="mt-4 px-4">
        {summary.status === 'loading' ? (
          <Skeleton className="h-16 w-full" />
        ) : summary.status === 'success' && summary.data ? (
          <div className="grid grid-cols-3 gap-2 rounded-md bg-surface-2 p-3 text-center">
            <SummaryCell label="Доходы" value={rubles(summary.data.totalIncome)} color="var(--income)" />
            <SummaryCell label="Расходы" value={rubles(summary.data.totalExpense)} color="var(--expense)" />
            <SummaryCell label="Баланс" value={rubles(summary.data.balance)} color="var(--text)" />
          </div>
        ) : null}
      </section>

      {/* Список */}
      <section className="mt-5 px-4">
        <SectionHeader
          title="Операции"
          right={txs.data ? <span className="num">{txs.data.total}</span> : null}
        />
        {txs.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : txs.status === 'error' ? (
          <ErrorState message={txs.error ?? undefined} onRetry={txs.reload} />
        ) : txs.data && txs.data.transactions.length > 0 ? (
          <TransactionList transactions={txs.data.transactions} />
        ) : (
          <EmptyState
            title="Нет операций за период"
            hint={
              entity_id !== null || direction_id !== null
                ? 'По выбранному юрлицу/направлению за этот период операций нет. Измените фильтр или период.'
                : 'Добавьте выписку или выберите другой период.'
            }
          />
        )}
      </section>
    </>
  );
}

function SummaryCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">{label}</p>
      <p className="num mt-0.5 text-[13px] font-semibold" style={{ color }}>
        {value}
      </p>
    </div>
  );
}
