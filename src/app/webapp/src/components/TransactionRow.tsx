/** Строка операции (§7.4): иконка-категория · название · мета · сумма со знаком. */

import {
  ArrowDownLeft,
  ArrowUpRight,
  Briefcase,
  Megaphone,
  Receipt,
  ShoppingBag,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { rublesSigned } from '../lib/money';
import { formatDateShort } from '../lib/dates';
import type { TransactionItem } from '../lib/types';

/** Подбор иконки по категории (с дефолтом по знаку суммы). */
function iconFor(tx: TransactionItem): LucideIcon {
  const cat = (tx.category ?? '').toLowerCase();
  if (cat.includes('реклам') || cat.includes('маркет')) return Megaphone;
  if (cat.includes('налог')) return Receipt;
  if (cat.includes('зарплат') || cat.includes('оплат труд') || cat.includes('подряд')) return Briefcase;
  if (cat.includes('закуп') || cat.includes('товар') || cat.includes('расход')) return ShoppingBag;
  if (cat.includes('выручк') || cat.includes('продаж') || cat.includes('доход')) return Wallet;
  return tx.amount >= 0 ? ArrowDownLeft : ArrowUpRight;
}

export function TransactionRow({
  tx,
  showDate = false,
}: {
  tx: TransactionItem;
  /** Показывать дату в мете (для негруппированных списков). */
  showDate?: boolean;
}) {
  const isIncome = tx.amount >= 0;
  const Icon = iconFor(tx);
  const color = isIncome ? 'var(--income)' : 'var(--expense)';
  const meta = [tx.direction, tx.category, showDate ? formatDateShort(tx.date) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex min-h-[44px] items-center gap-3 py-3">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-surface-3"
        style={{ color }}
        aria-hidden="true"
      >
        <Icon size={18} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] leading-[20px] text-ink">{tx.description}</p>
        {meta ? (
          <p className="truncate text-[11px] uppercase tracking-[0.03em] text-ink-faint">{meta}</p>
        ) : null}
      </div>
      <span className="num shrink-0 text-[15px] font-semibold" style={{ color }}>
        {rublesSigned(tx.amount)}
      </span>
    </div>
  );
}
