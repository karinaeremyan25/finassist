/** Хаб «Ещё»: входы в модули (ФОТ, Контрагенты, AI-команды) + Команда/Настройки. */

import { Link } from 'react-router-dom';
import { Wallet, Briefcase, CreditCard, Users as UsersIcon, Settings as SettingsIcon, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { useApp } from '../state/FilterContext';

export function More() {
  const { session } = useApp();
  const isOwner = session?.user.role === 'owner';

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-4 text-[22px] font-semibold text-ink">Ещё</h1>

        <SectionHeader title="Модули" />
        <div className="flex flex-col gap-2">
          <Row to="/employees" icon={Wallet} title="ФОТ" hint="Зарплаты, выплаты, остатки по сотрудникам" />
          <Row to="/contractors" icon={Briefcase} title="Контрагенты" hint="Счета, платежи, задолженность" />
          <Row to="/loans" icon={CreditCard} title="Кредиты" hint="Погашения кредитов по кредиторам" />
        </div>

        <div className="mt-6">
          <SectionHeader title="Управление" />
          <div className="flex flex-col gap-2">
            {isOwner ? (
              <Row to="/users" icon={UsersIcon} title="Команда и доступ" hint="Люди, роли, активность" />
            ) : null}
            <Row to="/settings" icon={SettingsIcon} title="Настройки" hint="Фильтры данных и период" />
          </div>
        </div>
      </section>
    </>
  );
}

function Row({
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
