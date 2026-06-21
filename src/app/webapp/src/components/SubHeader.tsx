/** Шапка вложенного экрана: кнопка «назад» + заголовок. */

import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { hapticSelection } from '../lib/telegram';

export function SubHeader({ title, fallback = '/more' }: { title: string; fallback?: string }) {
  const navigate = useNavigate();
  return (
    <header className="safe-top flex items-center gap-2 px-2 pb-3 pt-3" style={{ background: 'var(--grad-header)' }}>
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          // Если есть история — назад, иначе на хаб модулей.
          if (window.history.length > 1) navigate(-1);
          else navigate(fallback);
        }}
        className="flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-pill text-ink-muted active:text-ink active:bg-surface-3"
        aria-label="Назад"
      >
        <ChevronLeft size={24} strokeWidth={2} />
      </button>
      <h1 className="text-[18px] font-semibold text-ink">{title}</h1>
    </header>
  );
}
