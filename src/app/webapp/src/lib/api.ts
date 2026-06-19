/**
 * API-клиент. Добавляет X-Telegram-Init-Data ко всем запросам,
 * нормализует ошибки { error: { code, message } } в ApiClientError.
 */

import { getInitData } from './telegram';
import type {
  AdminDeleteResponse,
  AdminListResponse,
  AdminUserResponse,
  AiChatResponse,
  AnalyticsSummary,
  FundsResponse,
  InsightsResponse,
  Period,
  PersonalSpendingResponse,
  PlanResponse,
  PnlEntity,
  PnlResponse,
  PnlYearResponse,
  SessionResponse,
  SetTxCategoryResponse,
  TransactionsResponse,
  UsersResponse,
} from './types';

export class ApiClientError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

interface Filters {
  entity_id?: string | null;
  direction_id?: string | null;
}

function buildQuery(period: Period, filters?: Filters, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  params.set('from', period.from);
  params.set('to', period.to);
  if (filters?.entity_id) params.set('entity_id', filters.entity_id);
  if (filters?.direction_id) params.set('direction_id', filters.direction_id);
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params.toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'X-Telegram-Init-Data': getInitData(),
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiClientError('network_error', 'Нет соединения с сервером.', 0);
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const errObj =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error: { code?: string; message?: string } }).error
        : null;
    throw new ApiClientError(
      errObj?.code ?? 'http_error',
      errObj?.message ?? `Ошибка запроса (${res.status}).`,
      res.status
    );
  }

  return data as T;
}

export const api = {
  session(): Promise<SessionResponse> {
    return request<SessionResponse>('/api/webapp/session', { method: 'POST', body: '{}' });
  },

  summary(period: Period, filters?: Filters): Promise<AnalyticsSummary> {
    return request<AnalyticsSummary>(`/api/analytics/summary?${buildQuery(period, filters)}`);
  },

  insights(period: Period, filters?: Filters): Promise<InsightsResponse> {
    return request<InsightsResponse>(`/api/analytics/insights?${buildQuery(period, filters)}`);
  },

  transactions(
    period: Period,
    filters?: Filters,
    limit = 50,
    offset = 0
  ): Promise<TransactionsResponse> {
    const q = buildQuery(period, filters, { limit: String(limit), offset: String(offset) });
    return request<TransactionsResponse>(`/api/analytics/transactions?${q}`);
  },

  users(): Promise<UsersResponse> {
    return request<UsersResponse>('/api/webapp/users');
  },

  funds(): Promise<FundsResponse> {
    return request<FundsResponse>('/api/analytics/funds');
  },

  aiChat(body: {
    question: string;
    entity_id?: string | null;
    from?: string | null;
    to?: string | null;
    context?: string | null;
  }): Promise<AiChatResponse> {
    return request<AiChatResponse>('/api/ai-chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** План/факт за месяц (YYYY-MM). По умолчанию — текущий месяц МСК. */
  plan(month?: string): Promise<PlanResponse> {
    const q = month ? `?month=${encodeURIComponent(month)}` : '';
    return request<PlanResponse>(`/api/analytics/plan${q}`);
  },

  // ── P&L (/api/analytics/pnl*) ────────────────────────────────────────────

  /** P&L за месяц (YYYY-MM) по юрлицу/сводный. Суммы — копейки. */
  pnl(entity: PnlEntity, period: string): Promise<PnlResponse> {
    const q = new URLSearchParams({ entity, period }).toString();
    return request<PnlResponse>(`/api/analytics/pnl?${q}`);
  },

  /** Годовой P&L помесячно. */
  pnlYear(entity: PnlEntity, year: number): Promise<PnlYearResponse> {
    const q = new URLSearchParams({ entity, year: String(year) }).toString();
    return request<PnlYearResponse>(`/api/analytics/pnl/year?${q}`);
  },

  /** Личные траты собственника за месяц (YYYY-MM). */
  personalSpending(period: string): Promise<PersonalSpendingResponse> {
    const q = new URLSearchParams({ period }).toString();
    return request<PersonalSpendingResponse>(`/api/analytics/personal-spending?${q}`);
  },

  /** Ручное исправление категории транзакции бухгалтером. */
  setTxCategory(id: string, category: string): Promise<SetTxCategoryResponse> {
    return request<SetTxCategoryResponse>('/api/analytics/transactions/category', {
      method: 'PATCH',
      body: JSON.stringify({ id, category }),
    });
  },

  /** Ручная синхронизация с Точкой (кнопка «Обновить»). */
  syncTochka(): Promise<{ ok: boolean; added?: number; balancesUpdated?: number; classified?: number; dateTo?: string; error?: string }> {
    return request('/api/tochka/sync', { method: 'POST', body: '{}' });
  },

  exportReport(period: Period, filters?: Filters): Promise<{ ok: boolean; rows?: number; error?: string }> {
    return request(`/api/analytics/export?${buildQuery(period, filters)}`);
  },

  // ── Админка: управление пользователями (только owner) ────────────────────

  adminListUsers(): Promise<AdminListResponse> {
    return request<AdminListResponse>('/api/admin/users');
  },

  adminAddUser(username: string, role?: string): Promise<AdminUserResponse> {
    return request<AdminUserResponse>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(role ? { username, role } : { username }),
    });
  },

  adminUpdateUser(
    id: string,
    patch: { isActive?: boolean; role?: string }
  ): Promise<AdminUserResponse> {
    return request<AdminUserResponse>('/api/admin/users', {
      method: 'PATCH',
      body: JSON.stringify({ id, ...patch }),
    });
  },

  adminDeleteUser(id: string): Promise<AdminDeleteResponse> {
    return request<AdminDeleteResponse>('/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
  },
};
