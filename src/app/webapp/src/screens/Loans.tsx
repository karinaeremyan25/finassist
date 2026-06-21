/**
 * Экран «Кредиты» — расходы pnl_category='loan' по кредиторам. Карточка кредитора:
 * сколько выплачено, период, разворот → платежи (дата/сумма). Суммы — копейки.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SubHeader } from '../components/SubHeader';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles } from '../lib/money';
import { hapticSelection } from '../lib/telegram';
import type { LoanCreditorRow } from '../lib/types';

export function Loans() {
  const list = useAsync(() => api.loans(), []);

  return (
    <>
      <SubHeader title="Кредиты" />
      <section className="px-4 pt-3">
        <p className="mb-4 text-[13px] text-ink-muted">Погашения кредитов по кредиторам.</p>

        {list.status === 'success' && list.data && list.data.data.length > 0 ? (
          <div className="mb-4 rounded-md bg-surface-2 p-4">
            <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">Всего выплачено</p>
            <p className="num mt-1 text-[24px] font-bold text-ink">{rubles(list.data.total)}</p>
          </div>
        ) : null}

        {list.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        ) : list.status === 'error' ? (
          <ErrorState message={list.error ?? undefined} onRetry={list.reload} />
        ) : !list.data || list.data.data.length === 0 ? (
          <EmptyState title="Кредитов нет" hint="Здесь появятся погашения с категорией «Кредиты»." />
        ) : (
          <ul className="flex flex-col gap-3">
            {list.data.data.map((c) => (
              <CreditorCard key={c.name} c={c} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function CreditorCard({ c }: { c: LoanCreditorRow }) {
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
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-ink">{c.name}</span>
          <span className="num block truncate text-[12px] text-ink-faint">
            {c.count} платеж(ей) · {c.first_date.slice(0, 10)} … {c.last_date.slice(0, 10)}
          </span>
        </span>
        <span className="num shrink-0 text-[15px] font-semibold text-warning">{rubles(c.total_paid)}</span>
        {open ? (
          <ChevronDown size={18} className="shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight size={18} className="shrink-0 text-ink-faint" />
        )}
      </button>

      {open ? (
        <ul className="divide-y divide-border border-t border-border px-4">
          {c.payments.map((p) => (
            <li key={p.id} className="flex items-baseline justify-between gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{p.description ?? 'Платёж'}</span>
                <span className="num block text-[11px] text-ink-faint">
                  {p.date.slice(0, 10)}
                  {p.tochka_transaction_id ? ' · чек Точки' : ''}
                </span>
              </span>
              <span className="num shrink-0 text-[13px] font-semibold text-ink">{rubles(p.amount)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
