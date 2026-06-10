/** Строка операции (§7.4): иконка категории · название · мета · сумма со знаком. */

import {
  ArrowDownLeft,
  ArrowUpRight,
  type LucideIcon,
} from 'lucide-react';
import { rublesSigned } from '../lib/money';
import { formatDateShort } from '../lib/dates';
import type { TransactionItem } from '../lib/types';

function iconFor(amount: number): LucideIcon {
  return amount >= 0 ? ArrowDownLeft : ArrowUpRight;
}

export function TransactionRow({ tx }: { tx: TransactionItem }) {
  const isIncome = tx.amount >= 0;
  const Icon = iconFor(tx.amount);
  const meta = [tx.direction, formatDateShort(tx.date)].filter(Boolean).join(' · ');

  return (
    <div className="flex min-h-[44px] items-center gap-3 py-3">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-surface-3"
        style={{ color: isIncome ? 'var(--income)' : 'var(--expense)' }}
        aria-hidden="true"
      >
        <Icon size={18} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] leading-[20px] text-ink">{tx.description}</p>
        <p className="truncate text-[11px] uppercase tracking-[0.03em] text-ink-faint">{meta}</p>
      </div>
      <span
        className="num shrink-0 text-[15px] font-semibold"
        style={{ color: isIncome ? 'var(--income)' : 'var(--expense)' }}
      >
        {rublesSigned(tx.amount)}
      </span>
    </div>
  );
}
