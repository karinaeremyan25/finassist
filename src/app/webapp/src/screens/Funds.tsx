/** Экран «Фонды» (§7): карточки фондов с балансом и последними движениями. */

import { useState } from 'react';
import { ChevronDown, Landmark } from 'lucide-react';
import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { Skeleton, ErrorState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles } from '../lib/money';
import { formatDateShort } from '../lib/dates';
import { hapticSelection } from '../lib/telegram';
import type { FundCard as FundCardData, FundMovement } from '../lib/types';

/** «Пустые» фонды (нулевой баланс без движений) — в самый низ. */
function isEmptyFund(f: FundCardData): boolean {
  return f.balance === 0 && f.recentMovements.length === 0;
}

/** Сортировка: непустые по убыванию баланса, пустые — вниз. */
function sortFunds(funds: FundCardData[]): FundCardData[] {
  return [...funds].sort((a, b) => {
    const ae = isEmptyFund(a);
    const be = isEmptyFund(b);
    if (ae !== be) return ae ? 1 : -1;
    return b.balance - a.balance;
  });
}

export function Funds() {
  const funds = useAsync(() => api.funds(), []);

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">Фонды</h1>
        <p className="mb-4 text-[13px] text-ink-muted">
          Балансы фондов и последние движения по ним.
        </p>

        <SectionHeader title="Фонды" />

        {funds.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : funds.status === 'error' ? (
          <ErrorState message={funds.error ?? undefined} onRetry={funds.reload} />
        ) : funds.data && funds.data.funds.length > 0 ? (
          <div className="flex flex-col gap-3">
            {sortFunds(funds.data.funds).map((fund) => (
              <FundCard key={fund.id} fund={fund} />
            ))}
          </div>
        ) : (
          <FundsEmpty />
        )}
      </section>
    </>
  );
}

function FundCard({ fund }: { fund: FundCardData }) {
  const [expanded, setExpanded] = useState(false);
  const hasMovements = fund.recentMovements.length > 0;
  const visible = expanded ? fund.recentMovements : fund.recentMovements.slice(0, 5);

  return (
    <div className="rounded-lg bg-surface-2 shadow-elev-1">
      <button
        type="button"
        disabled={!hasMovements}
        onClick={() => {
          if (!hasMovements) return;
          hapticSelection();
          setExpanded((v) => !v);
        }}
        className="flex w-full items-start gap-3 p-4 text-left disabled:cursor-default"
      >
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-3 text-accent"
          aria-hidden="true"
        >
          <Landmark size={20} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
            {fund.name}
          </p>
          <p className="num mt-1 text-[26px] font-bold leading-[30px] text-ink">
            {rubles(fund.balance)}
          </p>
        </div>
        {hasMovements ? (
          <ChevronDown
            size={20}
            strokeWidth={2}
            className="mt-1 shrink-0 text-ink-faint transition-transform"
            style={expanded ? { transform: 'rotate(180deg)' } : undefined}
            aria-hidden="true"
          />
        ) : null}
      </button>

      {hasMovements ? (
        <ul className="border-t border-border px-4 pb-2">
          {visible.map((mv, i) => (
            <MovementRow key={i} mv={mv} />
          ))}
        </ul>
      ) : (
        <p className="border-t border-border px-4 py-3 text-[13px] text-ink-faint">
          Движений пока нет.
        </p>
      )}
    </div>
  );
}

function MovementRow({ mv }: { mv: FundMovement }) {
  const isIn = mv.kind === 'in';
  const color = isIn ? 'var(--income)' : 'var(--expense)';
  const sign = isIn ? '+' : '−';
  return (
    <li className="flex min-h-[44px] items-center gap-3 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] leading-[18px] text-ink">{mv.description}</p>
        <p className="truncate text-[11px] uppercase tracking-[0.03em] text-ink-faint">
          {formatDateShort(mv.date)}
        </p>
      </div>
      <span className="num shrink-0 text-[14px] font-semibold" style={{ color }}>
        {sign}
        {rubles(mv.amount)}
      </span>
    </li>
  );
}

function FundsEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-2 text-ink-muted">
        <Landmark size={24} strokeWidth={1.5} />
      </div>
      <p className="text-[15px] font-medium text-ink">Фонды пусто</p>
      <p className="text-[13px] leading-[18px] text-ink-faint">
        Подключите Точку, чтобы подтянуть балансы.
      </p>
    </div>
  );
}
