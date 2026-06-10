/** Шапка (§7.1): бренд + аватар + настройки. Фон --grad-header. */

import { useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useApp } from '../state/FilterContext';

export function Header() {
  const navigate = useNavigate();
  const { session } = useApp();
  const name = session?.user.name ?? 'Гость';
  const initial = name.trim().charAt(0).toUpperCase() || 'К';

  return (
    <header
      className="safe-top px-4 pb-5 pt-3"
      style={{ background: 'var(--grad-header)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-soft">
          Психология Здоровья
        </span>
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-pill bg-surface-3 text-[13px] font-semibold text-ink"
            aria-label={`Профиль: ${name}`}
          >
            {initial}
          </div>
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center text-ink-muted active:text-ink"
            aria-label="Настройки"
          >
            <Settings size={20} strokeWidth={2} />
          </button>
        </div>
      </div>
    </header>
  );
}
