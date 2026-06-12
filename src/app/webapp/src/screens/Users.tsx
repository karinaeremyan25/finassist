/**
 * Экран «Команда / Доступ» — управление людьми (только owner).
 * /api/admin/users: GET список, POST добавить @username, PATCH роль/активность,
 * DELETE soft-delete. Не-owner получает 403 → заглушка.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  UserRound,
  UserPlus,
  Trash2,
  ShieldAlert,
  Check,
  X,
  Power,
  PowerOff,
} from 'lucide-react';
import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { api, ApiClientError } from '../lib/api';
import { useApp } from '../state/FilterContext';
import { formatDateTime } from '../lib/dates';
import { hapticSelection } from '../lib/telegram';
import type { AdminRole, AdminUser } from '../lib/types';

const ROLE_LABEL: Record<AdminRole, string> = {
  owner: 'Владелец',
  accountant: 'Бухгалтер',
  manager: 'Менеджер',
};

const ROLES: AdminRole[] = ['owner', 'accountant', 'manager'];

function isRole(v: string): v is AdminRole {
  return v === 'owner' || v === 'accountant' || v === 'manager';
}

type Status = 'loading' | 'ready' | 'error' | 'forbidden';

export function Users() {
  const { session } = useApp();
  // Сессия отдаёт role; админку показываем только владельцу.
  const sessionRole = session?.user.role ?? null;

  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await api.adminListUsers();
      setUsers(res.users);
      setStatus('ready');
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setStatus('forbidden');
        return;
      }
      setError(err instanceof ApiClientError ? err.message : 'Не удалось загрузить список.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // Если бэк сообщил роль и это не owner — даже не дёргаем эндпоинт.
    if (sessionRole !== null && sessionRole !== 'owner') {
      setStatus('forbidden');
      return;
    }
    void load();
  }, [load, sessionRole]);

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">Команда и доступ</h1>
        <p className="mb-4 text-[13px] text-ink-muted">
          У всех ролей одинаковый полный доступ. Роль — для аудита операций.
        </p>

        {status === 'forbidden' ? (
          <Forbidden />
        ) : status === 'error' ? (
          <ErrorState message={error ?? undefined} onRetry={() => void load()} />
        ) : (
          <>
            <AddUserForm onAdded={() => void load()} />

            <SectionHeader title="Пользователи" />

            {status === 'loading' ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-md" />
                ))}
              </div>
            ) : users.length === 0 ? (
              <EmptyState title="Нет пользователей" hint="Добавьте человека по @username." />
            ) : (
              <div className="flex flex-col gap-3">
                {users.map((u) => (
                  <UserCard
                    key={u.id}
                    user={u}
                    onChanged={(next) =>
                      setUsers((prev) => prev.map((x) => (x.id === next.id ? next : x)))
                    }
                    onDeleted={(id) => setUsers((prev) => prev.filter((x) => x.id !== id))}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

// ── Заглушка для не-владельца ───────────────────────────────────────────────

function Forbidden() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md bg-surface-2 text-warning">
        <ShieldAlert size={24} strokeWidth={1.5} />
      </div>
      <p className="text-[15px] font-medium text-ink">Доступ ограничен</p>
      <p className="text-[13px] leading-[18px] text-ink-faint">
        Управление доступом доступно только владельцу.
      </p>
    </div>
  );
}

// ── Форма добавления ────────────────────────────────────────────────────────

function AddUserForm({ onAdded }: { onAdded: () => void }) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<AdminRole>('manager');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const value = username.trim();
    if (value.length === 0) {
      setError('Введите @username.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.adminAddUser(value, role);
      setUsername('');
      setRole('manager');
      hapticSelection();
      onAdded();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Не удалось добавить.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-md bg-surface-2 p-4">
      <p className="mb-3 text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
        Добавить человека
      </p>
      <div className="flex flex-col gap-2">
        <input
          type="text"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="@username"
          className="min-h-[44px] w-full rounded-sm border border-border bg-surface-1 px-3 text-[15px] text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <div className="flex gap-2">
          <select
            value={role}
            onChange={(e) => {
              if (isRole(e.target.value)) setRole(e.target.value);
            }}
            className="min-h-[44px] flex-1 rounded-sm border border-border bg-surface-1 px-3 text-[15px] text-ink"
            aria-label="Роль нового пользователя"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-sm bg-accent px-4 text-[15px] font-semibold text-accent-ink shadow-glow active:opacity-90 disabled:opacity-50"
          >
            <UserPlus size={18} strokeWidth={2} />
            Добавить
          </button>
        </div>
      </div>
      {error ? <p className="mt-2 text-[13px] text-expense">{error}</p> : null}
      <p className="mt-2 text-[12px] leading-[16px] text-ink-faint">
        Человек получит доступ при первом открытии приложения.
      </p>
    </div>
  );
}

// ── Карточка пользователя ───────────────────────────────────────────────────

function UserCard({
  user,
  onChanged,
  onDeleted,
}: {
  user: AdminUser;
  onChanged: (next: AdminUser) => void;
  onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = user.fullName ?? (user.username ? `@${user.username}` : 'Без имени');
  const subtitle = user.fullName && user.username ? `@${user.username}` : null;

  async function patchRole(role: AdminRole) {
    if (role === user.role) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.adminUpdateUser(user.id, { role });
      hapticSelection();
      onChanged(res.user);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Не удалось изменить роль.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.adminUpdateUser(user.id, { isActive: !user.isActive });
      hapticSelection();
      onChanged(res.user);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Не удалось изменить статус.');
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await api.adminDeleteUser(user.id);
      hapticSelection();
      onDeleted(user.id);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Не удалось удалить.');
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="rounded-md bg-surface-2 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-3 text-ink-muted">
          <UserRound size={18} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] text-ink">{title}</p>
          {subtitle ? (
            <p className="truncate text-[12px] text-ink-faint">{subtitle}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="role">{ROLE_LABEL[user.role]}</Badge>
            {user.pending ? (
              <Badge tone="pending">ожидает входа</Badge>
            ) : user.isActive ? (
              <Badge tone="active">активен</Badge>
            ) : (
              <Badge tone="off">выключен</Badge>
            )}
            {user.lastSeen && !user.pending ? (
              <span className="num text-[11px] text-ink-faint">
                {formatDateTime(user.lastSeen)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Управление */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={user.role}
          disabled={busy}
          onChange={(e) => {
            if (isRole(e.target.value)) void patchRole(e.target.value);
          }}
          className="min-h-[44px] flex-1 rounded-sm border border-border bg-surface-1 px-3 text-[14px] text-ink disabled:opacity-50"
          aria-label={`Роль: ${title}`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => void toggleActive()}
          disabled={busy}
          aria-label={user.isActive ? 'Выключить доступ' : 'Включить доступ'}
          className="flex h-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-border bg-surface-1 px-3 text-ink-muted active:text-ink disabled:opacity-50"
        >
          {user.isActive ? (
            <PowerOff size={18} strokeWidth={2} />
          ) : (
            <Power size={18} strokeWidth={2} />
          )}
        </button>

        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void doDelete()}
              disabled={busy}
              aria-label="Подтвердить удаление"
              className="flex h-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-sm bg-expense px-3 text-[14px] font-semibold text-accent-ink active:opacity-90 disabled:opacity-50"
            >
              <Check size={18} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
              aria-label="Отменить удаление"
              className="flex h-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-border bg-surface-1 px-3 text-ink-muted active:text-ink disabled:opacity-50"
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            aria-label={`Удалить ${title}`}
            className="flex h-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-border bg-surface-1 px-3 text-expense active:opacity-90 disabled:opacity-50"
          >
            <Trash2 size={18} strokeWidth={2} />
          </button>
        )}
      </div>

      {confirmDelete ? (
        <p className="mt-2 text-[12px] text-ink-faint">Удалить пользователя? Действие подтвердите галочкой.</p>
      ) : null}
      {error ? <p className="mt-2 text-[13px] text-expense">{error}</p> : null}
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: string;
  tone: 'role' | 'pending' | 'active' | 'off';
}) {
  const styles: Record<typeof tone, { bg: string; color: string }> = {
    role: { bg: 'var(--surface-3)', color: 'var(--text)' },
    pending: { bg: 'rgba(251, 191, 36, 0.15)', color: 'var(--warning)' },
    active: { bg: 'rgba(52, 211, 153, 0.15)', color: 'var(--income)' },
    off: { bg: 'rgba(255,255,255,0.06)', color: 'var(--text-faint)' },
  };
  const s = styles[tone];
  return (
    <span
      className="rounded-pill px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.03em]"
      style={{ background: s.bg, color: s.color }}
    >
      {children}
    </span>
  );
}
