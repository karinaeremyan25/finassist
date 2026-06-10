/** Экран Users (§9): пользователи и доступ. Роли — для аудита, доступ полный. */

import { UserRound } from 'lucide-react';
import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/dates';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Владелец',
  accountant: 'Бухгалтер',
  manager: 'Менеджер',
};

export function Users() {
  const users = useAsync(() => api.users(), []);

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">Счета и доступ</h1>
        <p className="mb-4 text-[13px] text-ink-muted">
          У всех ролей одинаковый полный доступ. Роль — для аудита операций.
        </p>

        <SectionHeader title="Пользователи" />
        {users.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : users.status === 'error' ? (
          <ErrorState message={users.error ?? undefined} onRetry={users.reload} />
        ) : users.data && users.data.users.length > 0 ? (
          <div className="divide-y divide-border rounded-md bg-surface-2 px-4">
            {users.data.users.map((u) => (
              <div key={u.telegram_id} className="flex items-center gap-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-3 text-ink-muted">
                  <UserRound size={18} strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] text-ink">{u.name}</p>
                  <p className="truncate text-[11px] uppercase tracking-[0.03em] text-ink-faint">
                    {ROLE_LABEL[u.role] ?? u.role}
                    {u.last_seen ? ` · ${formatDateTime(u.last_seen)}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="Нет пользователей" hint="" />
        )}
      </section>
    </>
  );
}
