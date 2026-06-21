/**
 * Экран ФОТ (SPEC v2.1 US-101). Список сотрудников: оклад, выплачено за месяц,
 * остаток. Клик по сотруднику → его операции (с пометкой источника). Фильтр по
 * юрлицу. Все суммы из API — копейки.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Header } from '../components/Header';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles, rublesSigned } from '../lib/money';
import { hapticSelection } from '../lib/telegram';
import type { Company, EmployeeRow, EmployeeTxItem } from '../lib/types';

type CompanyFilter = Company | 'all';

const FILTERS: Array<{ key: CompanyFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'ip', label: 'ИП' },
  { key: 'ooo', label: 'ООО' },
];

export function Employees() {
  const [filter, setFilter] = useState<CompanyFilter>('all');
  const company = filter === 'all' ? undefined : filter;
  const list = useAsync(() => api.employees(company, 'active'), [filter]);

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">ФОТ</h1>
        <p className="mb-4 text-[13px] text-ink-muted">Зарплаты, выплаты и остатки по сотрудникам.</p>

        <div className="mb-4 flex gap-1 rounded-pill bg-surface-1 p-1">
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  hapticSelection();
                  setFilter(f.key);
                }}
                className={`min-h-[36px] flex-1 rounded-pill text-[13px] font-semibold transition-colors ${
                  active ? 'bg-accent text-accent-ink shadow-glow' : 'text-ink-muted'
                }`}
                aria-pressed={active}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="px-4 pb-4">
        {list.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        ) : list.status === 'error' ? (
          <ErrorState message={list.error ?? undefined} onRetry={list.reload} />
        ) : !list.data || list.data.data.length === 0 ? (
          <EmptyState title="Нет сотрудников" hint="Сотрудники появятся после добавления." />
        ) : (
          <ul className="flex flex-col gap-3">
            {list.data.data.map((e) => (
              <EmployeeCard key={e.id} e={e} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function EmployeeCard({ e }: { e: EmployeeRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="overflow-hidden rounded-md bg-surface-2">
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-3"
        aria-expanded={open}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-3 text-[13px] font-semibold text-accent">
          {e.company_id.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-ink">{e.full_name}</span>
          <span className="block truncate text-[12px] text-ink-faint">{e.position ?? 'без должности'}</span>
        </span>
        <span className="shrink-0 text-right">
          {e.balance === null ? (
            <span className="text-[12px] text-warning">оклад не задан</span>
          ) : (
            <>
              <span className="num block text-[14px] font-semibold text-ink">{rubles(e.total_paid_current)}</span>
              <span className="num block text-[11px] text-ink-faint">остаток {rubles(e.balance)}</span>
            </>
          )}
        </span>
        {open ? (
          <ChevronDown size={18} className="shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight size={18} className="shrink-0 text-ink-faint" />
        )}
      </button>

      {open ? (
        <div className="border-t border-border px-4 py-2">
          <div className="flex items-center justify-between py-1.5 text-[12px] text-ink-muted">
            <span>Оклад/мес</span>
            <span className="num text-ink">{e.salary_monthly === null ? '—' : rubles(e.salary_monthly)}</span>
          </div>
          <div className="flex items-center justify-between py-1.5 text-[12px] text-ink-muted">
            <span>Выплачено (пред. месяц)</span>
            <span className="num text-ink">{rubles(e.total_paid_prev)}</span>
          </div>
          <EmployeeTxList id={e.id} />
        </div>
      ) : null}
    </li>
  );
}

function EmployeeTxList({ id }: { id: string }) {
  const txs = useAsync(() => api.employeeTransactions(id), [id]);
  if (txs.status === 'loading') return <Skeleton className="mt-2 h-16 w-full rounded-md" />;
  if (txs.status === 'error') return <p className="py-2 text-[12px] text-expense">Не удалось загрузить операции.</p>;
  if (!txs.data || txs.data.data.length === 0)
    return <p className="py-2 text-[12px] text-ink-faint">Операций нет.</p>;
  return (
    <ul className="mt-1 divide-y divide-border border-t border-border">
      {txs.data.data.map((t) => (
        <EmployeeTxRow key={t.id} t={t} />
      ))}
    </ul>
  );
}

function EmployeeTxRow({ t }: { t: EmployeeTxItem }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{t.description ?? t.counterparty ?? 'Операция'}</span>
        <span className="num block text-[11px] text-ink-faint">
          {t.date_transaction.slice(0, 10)}
          {t.tx_status === 'pending' ? ' · в пути' : ''}
          {t.tochka_transaction_id ? ' · чек Точки' : ''}
        </span>
      </span>
      <span
        className="num shrink-0 text-[13px] font-semibold"
        style={{ color: t.amount < 0 ? 'var(--expense)' : 'var(--income)' }}
      >
        {rublesSigned(t.amount)}
      </span>
    </li>
  );
}
