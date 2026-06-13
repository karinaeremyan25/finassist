/** Строка операции (§7.4): иконка-категория · название · мета · сумма со знаком.
 *  Кликабельна — по тапу открывает детальную карточку (bottom sheet). */

import { useState } from 'react';
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
import { categoryOptionLabel } from '../lib/categories';
import { TransactionDetail } from './TransactionDetail';
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
  onChanged,
}: {
  tx: TransactionItem;
  /** Показывать дату в мете (для негруппированных списков). */
  showDate?: boolean;
  /** Колбэк для перезапроса списка после смены категории. */
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);

  const isIncome = tx.amount >= 0;
  const Icon = iconFor(tx);
  const color = isIncome ? 'var(--income)' : 'var(--expense)';
  // Категория для меты: человекочитаемый pnl_category, иначе исходная.
  const catText = categoryOptionLabel(tx.pnlCategory) ?? tx.category;
  const meta = [tx.direction, catText, showDate ? formatDateShort(tx.date) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-[44px] w-full items-center gap-3 py-3 text-left active:bg-surface-3/40"
      >
        <div
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-surface-3"
          style={{ color }}
          aria-hidden="true"
        >
          <Icon size={18} strokeWidth={2} />
          {tx.needsReview ? (
            <span
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-pill ring-2 ring-surface-2"
              style={{ background: 'var(--warning)' }}
              aria-hidden="true"
            />
          ) : null}
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
      </button>

      {open ? (
        <TransactionDetail tx={tx} onClose={() => setOpen(false)} onChanged={onChanged} />
      ) : null}
    </>
  );
}
