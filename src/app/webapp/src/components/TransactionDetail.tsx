/**
 * Детальная карточка операции (bottom sheet, §детали).
 * По тапу на строку: контрагент, назначение, сумма, дата (МСК), направление,
 * категория + смена категории через PATCH /api/analytics/transactions/category.
 */

import { useEffect, useState } from 'react';
import { X, AlertTriangle, Check } from 'lucide-react';
import { rublesSigned } from '../lib/money';
import { formatDateTime } from '../lib/dates';
import {
  ALL_CATEGORY_OPTIONS,
  categoryOptionLabel,
} from '../lib/categories';
import { api } from '../lib/api';
import { ApiClientError } from '../lib/api';
import type { TransactionItem } from '../lib/types';

interface Props {
  tx: TransactionItem;
  onClose: () => void;
  /** Вызывается после успешной смены категории — для перезапроса списка. */
  onChanged?: () => void;
}

export function TransactionDetail({ tx, onClose, onChanged }: Props) {
  const isIncome = tx.amount >= 0;
  const color = isIncome ? 'var(--income)' : 'var(--expense)';

  const [selected, setSelected] = useState<string>(tx.pnlCategory ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Закрытие по Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Блокируем прокрутку фона, пока открыт лист.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function changeCategory(code: string) {
    if (code === '' || code === tx.pnlCategory) {
      setSelected(code);
      return;
    }
    setSelected(code);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.setTxCategory(tx.id, code);
      setSaved(true);
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Не удалось сменить категорию.'
      );
      setSelected(tx.pnlCategory ?? '');
    } finally {
      setSaving(false);
    }
  }

  const categoryLabel = categoryOptionLabel(tx.pnlCategory) ?? tx.category;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Детали операции"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />

      {/* Sheet */}
      <div
        className="relative z-10 w-full max-w-app rounded-t-lg bg-surface-1 px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-elev-2"
        style={{ animation: 'sheet-up 0.22s ease-out' }}
      >
        {/* Grabber + close */}
        <div className="relative mb-2 flex items-center justify-center">
          <span className="h-1 w-10 rounded-pill bg-border-strong" aria-hidden="true" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="absolute right-0 flex h-8 w-8 items-center justify-center rounded-pill text-ink-muted active:bg-surface-3"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Сумма */}
        <div className="mb-4 text-center">
          <p className="num text-[30px] font-bold leading-[36px]" style={{ color }}>
            {rublesSigned(tx.amount)}
          </p>
          {tx.needsReview ? (
            <p
              className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium"
              style={{ color: 'var(--warning)' }}
            >
              <AlertTriangle size={13} strokeWidth={2} />
              Требует проверки
            </p>
          ) : null}
        </div>

        {/* Поля */}
        <dl className="flex flex-col divide-y divide-border rounded-md bg-surface-2 px-4">
          <DetailRow label="Контрагент" value={tx.counterparty ?? '—'} />
          <DetailRow label="Назначение" value={tx.description || '—'} />
          <DetailRow label="Дата" value={formatDateTime(tx.date)} />
          <DetailRow label="Направление" value={tx.direction ?? '—'} />
          <DetailRow label="Категория" value={categoryLabel || '—'} />
        </dl>

        {/* Смена категории */}
        {isIncome ? (
          <p className="mt-4 text-center text-[13px] text-ink-faint">
            Доходная операция — категория не меняется.
          </p>
        ) : (
          <div className="mt-4">
            <label
              htmlFor="tx-category"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-faint"
            >
              Сменить категорию
            </label>
            <div className="relative">
              <select
                id="tx-category"
                value={selected}
                disabled={saving}
                onChange={(e) => void changeCategory(e.target.value)}
                className="num w-full appearance-none rounded-md border border-border-strong bg-surface-2 px-4 py-3 text-[15px] text-ink outline-none focus:border-accent disabled:opacity-60"
              >
                <option value="" disabled>
                  Выберите категорию…
                </option>
                <optgroup label="Бизнес">
                  {ALL_CATEGORY_OPTIONS.filter((c) => !c.code.startsWith('personal_')).map(
                    (c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    )
                  )}
                </optgroup>
                <optgroup label="Личные">
                  {ALL_CATEGORY_OPTIONS.filter((c) => c.code.startsWith('personal_')).map(
                    (c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    )
                  )}
                </optgroup>
              </select>
            </div>

            {saving ? (
              <p className="mt-2 text-[13px] text-ink-muted">Сохраняю…</p>
            ) : error ? (
              <p className="mt-2 text-[13px]" style={{ color: 'var(--expense)' }}>
                {error}
              </p>
            ) : saved ? (
              <p
                className="mt-2 inline-flex items-center gap-1 text-[13px]"
                style={{ color: 'var(--income)' }}
              >
                <Check size={14} strokeWidth={2} />
                Категория обновлена
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="shrink-0 text-[13px] text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[14px] text-ink">{value}</dd>
    </div>
  );
}
