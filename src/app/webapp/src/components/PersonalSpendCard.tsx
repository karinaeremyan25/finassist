/**
 * Карточка «Личные траты» собственника (Dashboard).
 * Дёргает personalSpending за текущий месяц МСК. До 6 категорий с прогресс-баром
 * и стрелкой vs пред. мес. Тап по карточке → /pnl. Если total=0 — null.
 */

import { useNavigate } from 'react-router-dom';
import { ArrowUp, ArrowDown, ArrowRight, Wallet } from 'lucide-react';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles, percentSigned } from '../lib/money';
import { currentMonthYm } from '../lib/dates';
import { hapticSelection } from '../lib/telegram';
import { Skeleton } from './States';
import type { PersonalSpendingCategory } from '../lib/types';

/** Цвета точек по коду категории (из спеки), fallback — серый. */
const CATEGORY_COLORS: Record<string, string> = {
  personal_food: '#534AB7',
  personal_shopping: '#D85A30',
  personal_fuel: '#BA7517',
  personal_restaurant: '#1D9E75',
  personal_entertainment: '#378ADD',
  personal_coffee: '#888780',
};

function categoryColor(code: string): string {
  return CATEGORY_COLORS[code] ?? '#888780';
}

function clampPct(pct: number): number {
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/** Для личных трат: рост — плохо (красный), снижение — хорошо (зелёный). */
function DeltaBadge({ pct }: { pct: number }) {
  const up = pct > 0;
  const down = pct < 0;
  const color = up ? 'var(--expense)' : down ? 'var(--income)' : 'var(--text-faint)';
  const Icon = up ? ArrowUp : down ? ArrowDown : ArrowRight;
  return (
    <span className="num inline-flex items-center gap-0.5 text-[11px]" style={{ color }}>
      <Icon size={12} strokeWidth={2.5} aria-hidden="true" />
      {percentSigned(pct)}
    </span>
  );
}

function CategoryRow({ cat }: { cat: PersonalSpendingCategory }) {
  const color = categoryColor(cat.code);
  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{cat.label}</span>
        <span className="num shrink-0 text-[14px] font-semibold text-ink">{rubles(cat.amount)}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-[18px]">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-pill"
          style={{ background: 'var(--chart-track)' }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(cat.pct)}
          aria-label={`${cat.label}: ${Math.round(cat.pct)}% от личных трат`}
        >
          <div
            className="h-full rounded-pill"
            style={{ width: `${clampPct(cat.pct)}%`, background: color }}
          />
        </div>
        <span className="num shrink-0 text-[11px] tabular-nums text-ink-faint">
          {Math.round(cat.pct)}%
        </span>
        <DeltaBadge pct={cat.vs_prev_month_pct} />
      </div>
    </li>
  );
}

export function PersonalSpendCard() {
  const navigate = useNavigate();
  const month = currentMonthYm();
  const spending = useAsync(() => api.personalSpending(month), [month]);

  if (spending.status === 'loading') {
    return <Skeleton className="h-44 w-full rounded-lg" />;
  }

  // Ошибку и пустоту скрываем — карточка вспомогательная (не должна ломать дашборд).
  if (spending.status !== 'success' || !spending.data || spending.data.total === 0) {
    return null;
  }

  const data = spending.data;
  const categories = data.categories.slice(0, 6);

  return (
    <button
      type="button"
      onClick={() => {
        hapticSelection();
        navigate('/pnl');
      }}
      className="w-full rounded-lg bg-surface-2 p-4 text-left shadow-elev-1 active:opacity-90"
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-3 text-accent"
          aria-hidden="true"
        >
          <Wallet size={20} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
            Личные траты
          </p>
          <p className="num mt-1 text-[24px] font-bold leading-[28px] text-ink">
            {rubles(data.total)}
          </p>
        </div>
        <div className="shrink-0 pt-1">
          <DeltaBadge pct={data.vs_prev_month_pct} />
          <p className="text-right text-[11px] text-ink-faint">vs пред. мес</p>
        </div>
      </div>

      {categories.length > 0 ? (
        <ul className="mt-3 border-t border-border pt-1">
          {categories.map((cat) => (
            <CategoryRow key={cat.code} cat={cat} />
          ))}
        </ul>
      ) : null}
    </button>
  );
}
