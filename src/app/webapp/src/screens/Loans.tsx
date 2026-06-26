/**
 * Экран «Кредиты» — расходы pnl_category='loan' по кредиторам. Карточка кредитора:
 * сколько выплачено, период, разворот → платежи (дата/сумма). Суммы — копейки.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SubHeader } from '../components/SubHeader';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { TransactionDetail } from '../components/TransactionDetail';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles } from '../lib/money';
import { hapticSelection } from '../lib/telegram';
import type { LoanCreditorRow, LoanPaymentItem, TransactionItem } from '../lib/types';

/** Платёж кредита → TransactionItem для общего bottom-sheet (просмотр + смена категории). */
function toTxItem(p: LoanPaymentItem, creditor: string): TransactionItem {
  return {
    id: p.id,
    date: p.date,
    description: p.description ?? '',
    // Платёж кредита — всегда расход: показываем со знаком минус.
    amount: -Math.abs(p.amount),
    direction: null,
    category: 'Кредиты',
    counterparty: creditor,
    pnlCategory: 'loan',
    isPersonal: false,
    needsReview: false,
  };
}

export function Loans() {
  const list = useAsync(() => api.loans(), []);

  return (
    <>
      <SubHeader title="Кредиты" />
      <section className="px-4 pt-3">
        <p className="mb-4 text-[13px] text-ink-muted">Погашения кредитов по кредиторам.</p>

        {list.status === 'success' && list.data && list.data.data.length > 0 ? (
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="rounded-md bg-surface-2 p-4">
              <p className="text-[12px] font-medium uppercase tracking-[0.04em] text-ink-muted">За этот месяц</p>
              <p className="num mt-1 text-[22px] font-bold text-warning">{rubles(list.data.month_total)}</p>
            </div>
            <div className="rounded-md bg-surface-2 p-4">
              <p className="text-[12px] font-medium uppercase tracking-[0.04em] text-ink-muted">Всего выплачено</p>
              <p className="num mt-1 text-[22px] font-bold text-ink">{rubles(list.data.total)}</p>
            </div>
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
              <CreditorCard key={c.name} c={c} onChanged={list.reload} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function CreditorCard({ c, onChanged }: { c: LoanCreditorRow; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TransactionItem | null>(null);
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
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  hapticSelection();
                  setDetail(toTxItem(p, c.name));
                }}
                className="flex w-full items-baseline justify-between gap-3 py-2 text-left active:bg-surface-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{p.description ?? 'Платёж'}</span>
                  <span className="num block text-[11px] text-ink-faint">
                    {p.date.slice(0, 10)}
                    {p.tochka_transaction_id ? ' · чек Точки' : ''} · изменить категорию →
                  </span>
                </span>
                <span className="num shrink-0 text-[13px] font-semibold text-ink">{rubles(p.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {detail ? (
        <TransactionDetail
          tx={detail}
          onClose={() => setDetail(null)}
          onChanged={onChanged}
        />
      ) : null}
    </li>
  );
}
