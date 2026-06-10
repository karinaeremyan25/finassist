/** Экран Settings (§9): выбор юрлица/направления/периода — пишет в общий стейт. */

import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { FilterBar } from '../components/FilterBar';
import { useApp } from '../state/FilterContext';
import { currentMonthFrom, today } from '../lib/dates';

export function Settings() {
  const { entities, directions, setPeriod, session } = useApp();

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
