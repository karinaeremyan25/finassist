/** Нижняя навигация (§7.6): 4 пункта, активная вкладка подсвечена --accent. */

import { NavLink } from 'react-router-dom';
import { Home, BarChart3, Wallet, MessageCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { hapticSelection } from '../lib/telegram';

interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
}

const TABS: Tab[] = [
  { to: '/dashboard', label: 'Главная', icon: Home },
  { to: '/transactions', label: 'Отчёты', icon: BarChart3 },
  { to: '/users', label: 'Счета', icon: Wallet },
  { to: '/chat', label: 'Чат', icon: MessageCircle },
];

export function BottomNav() {
  return (
    <nav
      className="safe-bottom fixed inset-x-0 bottom-0 z-20 mx-auto max-w-app border-t border-border bg-surface-nav/95 backdrop-blur"
      aria-label="Основная навигация"
    >
      <ul className="flex h-16 items-stretch">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <li key={tab.to} className="flex-1">
              <NavLink
                to={tab.to}
                onClick={() => hapticSelection()}
                className={({ isActive }) =>
                  `flex h-full min-h-[44px] flex-col items-center justify-center gap-1 ${
                    isActive ? 'text-accent' : 'text-ink-faint'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      size={22}
                      strokeWidth={2}
                      style={isActive ? { filter: 'drop-shadow(0 0 8px rgba(45,212,191,0.5))' } : undefined}
                    />
                    <span className="text-[11px] font-medium">{tab.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
