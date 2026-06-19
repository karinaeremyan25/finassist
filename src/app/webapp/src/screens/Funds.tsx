/** Экран «Фонды» (§7): карточки фондов с балансом и последними движениями. */

import { useState } from 'react';
import { ChevronDown, Landmark } from 'lucide-react';
import { Header } from '../components/Header';
import { Skeleton, ErrorState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles } from '../lib/money';
import { formatDateShort } from '../lib/dates';
import { hapticSelection } from '../lib/telegram';
import type { FundCard as FundCardData, FundMovement } from '../lib/types';

/** Сумма балансов группы (копейки). */
function groupTotal(funds: FundCardData[]): number {
  return funds.reduce((s, f) => s + f.balance, 0);
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

        {funds.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : funds.status === 'error' ? (
          <ErrorState message={funds.error ?? undefined} onRetry={funds.reload} />
        ) : funds.data && funds.data.funds.length > 0 ? (
          <FundsByEntity funds={funds.data.funds} />
        ) : (
          <FundsEmpty />
        )}
      </section>
    </>
  );
}

/** Группировка счетов: сначала ООО, потом ИП — с подытогом по каждому. */
function FundsByEntity({ funds }: { funds: FundCardData[] }) {
  const ooo = funds.filter((f) => f.entity === 'ooo');
  const ip = funds.filter((f) => f.entity === 'ip');
  return (
    <div className="flex flex-col gap-6">
      {ooo.length > 0 ? <EntityGroup title="ООО Ассургина" funds={ooo} /> : null}
      {ip.length > 0 ? <EntityGroup title="ИП Еремян" funds={ip} /> : null}
    </div>
  );
}

function EntityGroup({ title, funds }: { title: string; funds: FundCardData[] }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-ink-muted">{title}</h2>
        <span className="num text-[15px] font-bold text-ink">{rubles(groupTotal(funds))}</span>
      </div>
      <div className="flex flex-col gap-3">
        {funds.map((fund) => (
          <FundCard key={fund.id} fund={fund} />
        ))}
      </div>
    </div>
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
          {fund.account ? (
            <p className="num mt-0.5 text-[11px] text-ink-faint">счёт ···{fund.account}</p>
          ) : null}
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
