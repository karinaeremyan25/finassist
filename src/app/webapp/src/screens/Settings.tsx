/** Экран Settings (§9): выбор юрлица/направления/периода — пишет в общий стейт. */

import { Link } from 'react-router-dom';
import { Users as UsersIcon, Wallet, Briefcase, Sparkles, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { FilterBar } from '../components/FilterBar';
import { useApp } from '../state/FilterContext';
import { currentMonthFrom, today } from '../lib/dates';

export function Settings() {
  const { entities, directions, setPeriod, session } = useApp();
  // Сессия отдаёт role; пункт «Команда» показываем только владельцу.
  // TODO: если бэк перестанет отдавать role — пункт станет недоступен (откроется по прямому /users).
  const isOwner = session?.user.role === 'owner';

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-4 text-[22px] font-semibold text-ink">Настройки</h1>

        <SectionHeader title="Фильтр данных" />
        <FilterBar entities={entities} directions={directions} />

        <div className="mt-4 flex flex-wrap gap-2">
          <PeriodChip
            label="Текущий месяц"
            onClick={() => setPeriod({ from: currentMonthFrom(), to: today() })}
          />
          <PeriodChip
            label="Сегодня"
            onClick={() => setPeriod({ from: today(), to: today() })}
          />
        </div>

        <div className="mt-6">
          <SectionHeader title="Модули" />
          <div className="flex flex-col gap-2">
            <NavRow to="/employees" icon={Wallet} title="ФОТ" hint="Зарплаты, выплаты, остатки по сотрудникам" />
            <NavRow to="/contractors" icon={Briefcase} title="Контрагенты" hint="Счета, платежи, задолженность" />
            <NavRow to="/ai-commands" icon={Sparkles} title="AI-команды" hint="Счета, налог, переклассификация текстом" />
          </div>
        </div>

        {isOwner ? (
          <div className="mt-6">
            <SectionHeader title="Управление" />
            <Link
              to="/users"
              className="flex min-h-[44px] items-center gap-3 rounded-md bg-surface-2 px-4 py-3 active:bg-surface-3"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-3 text-accent">
                <UsersIcon size={18} strokeWidth={2} />
              </span>
              <span className="flex-1">
                <span className="block text-[15px] text-ink">Команда и доступ</span>
                <span className="block text-[12px] text-ink-faint">
                  Добавление людей, роли, активность
                </span>
              </span>
              <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-ink-faint" />
            </Link>
          </div>
        ) : null}

        {session ? (
          <div className="mt-6 rounded-md bg-surface-2 p-4 text-[13px] text-ink-muted">
            <p>
              Вошли как <span className="text-ink">{session.user.name}</span>
            </p>
            <p className="mt-1">Роль: {session.user.role}</p>
          </div>
        ) : null}
      </section>
    </>
  );
}

function NavRow({
  to,
  icon: Icon,
  title,
  hint,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-[44px] items-center gap-3 rounded-md bg-surface-2 px-4 py-3 active:bg-surface-3"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-3 text-accent">
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className="flex-1">
        <span className="block text-[15px] text-ink">{title}</span>
        <span className="block text-[12px] text-ink-faint">{hint}</span>
      </span>
      <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-ink-faint" />
    </Link>
  );
}

function PeriodChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-[44px] rounded-pill border border-border-strong bg-surface-2 px-4 text-[14px] text-ink active:bg-surface-3"
    >
      {label}
    </button>
  );
}
