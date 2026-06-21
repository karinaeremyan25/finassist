/**
 * Экран ФОТ (SPEC v2.1 US-101). Список сотрудников: оклад, выплачено за месяц,
 * остаток. Клик по сотруднику → его операции (с пометкой источника). Фильтр по
 * юрлицу. Все суммы из API — копейки.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SubHeader } from '../components/SubHeader';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { TransactionDetail } from '../components/TransactionDetail';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles, rublesSigned, rublesCompact, percentSigned } from '../lib/money';
import { hapticSelection } from '../lib/telegram';
import type { Company, EmployeeRow, EmployeeTxItem, TransactionItem } from '../lib/types';

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function monthLabel(ym: string): string {
  return MONTHS_SHORT[(Number(ym.split('-')[1]) || 1) - 1] ?? ym;
}

/** Карточка помесячной аналитики ФОТ: текущий месяц, %, мини-бары за 6 мес. */
function FotAnalytics() {
  const a = useAsync(() => api.employeesAnalytics(), []);
  if (a.status !== 'success' || !a.data || a.data.months.length === 0) return null;
  const d = a.data;
  const max = Math.max(...d.months.map((m) => m.total), 1);
  const deltaColor = d.delta_pct == null ? 'var(--text-faint)' : d.delta_pct > 0 ? 'var(--expense)' : 'var(--income)';
  return (
    <div className="mb-4 rounded-md bg-surface-2 p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">ФОТ за месяц</span>
        {d.delta_pct != null ? (
          <span className="num text-[12px]" style={{ color: deltaColor }}>
            {percentSigned(d.delta_pct)} к прошлому
          </span>
        ) : null}
      </div>
      <p className="num mt-1 text-[24px] font-bold text-ink">{rubles(d.current_month)}</p>
      <p className="num mt-0.5 text-[12px] text-ink-faint">в среднем {rublesCompact(d.avg_month)}/мес</p>
      <div className="mt-3 flex items-end gap-1.5" style={{ height: 56 }}>
        {d.months.map((m, i) => {
          const h = Math.max(4, Math.round((m.total / max) * 52));
          const last = i === d.months.length - 1;
          return (
            <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-sm"
                style={{ height: h, background: last ? 'var(--accent)' : 'var(--surface-3)' }}
                title={`${m.month}: ${rubles(m.total)}`}
              />
              <span className="text-[9px] text-ink-faint">{monthLabel(m.month)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
      <SubHeader title="ФОТ" />
      <section className="px-4 pt-3">
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
        <FotAnalytics />
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

/** EmployeeTxItem → TransactionItem для общего bottom-sheet «чек». */
function toTxItem(t: EmployeeTxItem): TransactionItem {
  return {
    id: t.id,
    date: t.date_transaction,
    description: t.description ?? '',
    amount: t.amount,
    direction: null,
    category: t.pnl_category ?? '',
    counterparty: t.counterparty,
    pnlCategory: t.pnl_category,
    isPersonal: false,
    needsReview: false,
  };
}

function EmployeeTxList({ id }: { id: string }) {
  const txs = useAsync(() => api.employeeTransactions(id), [id]);
  const [detail, setDetail] = useState<TransactionItem | null>(null);
  if (txs.status === 'loading') return <Skeleton className="mt-2 h-16 w-full rounded-md" />;
  if (txs.status === 'error') return <p className="py-2 text-[12px] text-expense">Не удалось загрузить операции.</p>;
  if (!txs.data || txs.data.data.length === 0)
    return <p className="py-2 text-[12px] text-ink-faint">Операций нет.</p>;
  return (
    <>
      <ul className="mt-1 divide-y divide-border border-t border-border">
        {txs.data.data.map((t) => (
          <EmployeeTxRow key={t.id} t={t} onOpen={() => setDetail(toTxItem(t))} />
        ))}
      </ul>
      {detail ? (
        <TransactionDetail tx={detail} onClose={() => setDetail(null)} onChanged={txs.reload} />
      ) : null}
    </>
  );
}

function EmployeeTxRow({ t, onOpen }: { t: EmployeeTxItem; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          onOpen();
        }}
        className="flex w-full items-baseline justify-between gap-3 py-2 text-left active:opacity-70"
      >
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
      </button>
    </li>
  );
}
