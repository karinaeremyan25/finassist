/** Общие состояния экранов (§8): Loading / Empty / Error. */

import { RefreshCw, Inbox } from 'lucide-react';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function ErrorState({
  message = 'Не удалось загрузить аналитику. Попробуйте позже.',
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <p className="text-[15px] leading-[22px] text-ink-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-accent px-5 text-[15px] font-semibold text-accent-ink shadow-glow active:opacity-90"
      >
        <RefreshCw size={18} strokeWidth={2} />
        Обновить
      </button>
    </div>
  );
}

export function EmptyState({
  title = 'Нет данных за выбранный период',
  hint = 'Добавьте выписку или выберите другой период.',
}: {
  title?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-2 text-ink-muted">
        <Inbox size={24} strokeWidth={1.5} />
      </div>
      <p className="text-[15px] font-medium text-ink">{title}</p>
      <p className="text-[13px] leading-[18px] text-ink-faint">{hint}</p>
    </div>
  );
}
