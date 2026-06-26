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
  AiAssistantResponse,
  AiCommandApproveResponse,
  AiCommandResponse,
  AnalyticsSummary,
  Company,
  ContractorsResponse,
  EmployeeStatus,
  EmployeeTransactionsResponse,
  EmployeesAnalyticsResponse,
  EmployeesResponse,
  FundsResponse,
  ImportConfirmResponse,
  ImportImageResponse,
  ImportedTxItem,
  IncomeBreakdownResponse,
  ExpenseBreakdownResponse,
  InsightsResponse,
  InTransitResponse,
  InvoiceGenerateResponse,
  LoansResponse,
  Period,
  PersonalSpendingResponse,
  PlanResponse,
  PnlEntity,
  PnlResponse,
  PnlYearResponse,
  SessionResponse,
  SetTxCategoryResponse,
  TranscribeResponse,
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

  /** Раскрытие дохода: из чего сложилась сумма (по источникам и продажам). */
  incomeBreakdown(entity: PnlEntity, period: string): Promise<IncomeBreakdownResponse> {
    const q = new URLSearchParams({ entity, period }).toString();
    return request<IncomeBreakdownResponse>(`/api/analytics/income-breakdown?${q}`);
  },

  /** Раскрытие статьи расходов: транзакции категории (проверка + переклассификация). */
  expenseBreakdown(entity: PnlEntity, period: string, category: string): Promise<ExpenseBreakdownResponse> {
    const q = new URLSearchParams({ entity, period, category }).toString();
    return request<ExpenseBreakdownResponse>(`/api/analytics/expense-breakdown?${q}`);
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

  // ── ФОТ (/api/employees) — US-101 ─────────────────────────────────────────

  employees(company?: Company, status: EmployeeStatus = 'active', period?: string): Promise<EmployeesResponse> {
    const p = new URLSearchParams();
    if (company) p.set('company', company);
    if (status) p.set('status', status);
    if (period) p.set('period', period);
    return request<EmployeesResponse>(`/api/employees?${p.toString()}`);
  },

  employeeTransactions(id: string): Promise<EmployeeTransactionsResponse> {
    return request<EmployeeTransactionsResponse>(`/api/employees/transactions?id=${encodeURIComponent(id)}`);
  },

  employeesAnalytics(): Promise<EmployeesAnalyticsResponse> {
    return request<EmployeesAnalyticsResponse>('/api/employees/analytics');
  },

  /** Выгрузка ФОТ в Excel — бот пришлёт файл в чат. */
  exportEmployees(): Promise<{ ok: boolean; rows?: number; error?: string }> {
    return request('/api/employees/export');
  },

  createEmployee(body: {
    company_id: Company;
    full_name: string;
    position?: string | null;
    salary_monthly?: string | number | null;
    match_pattern?: string | null;
  }): Promise<{ id: string }> {
    return request('/api/employees', { method: 'POST', body: JSON.stringify(body) });
  },

  // ── Контрагенты (/api/contractors) — US-102 ───────────────────────────────

  contractors(company?: Company): Promise<ContractorsResponse> {
    const q = company ? `?company=${company}` : '';
    return request<ContractorsResponse>(`/api/contractors${q}`);
  },

  createContractor(body: {
    company_id: Company;
    name: string;
    inn?: string | null;
    match_pattern?: string | null;
  }): Promise<{ id: string }> {
    return request('/api/contractors', { method: 'POST', body: JSON.stringify(body) });
  },

  /** Завести контрагентов из выписки Точки (по counterparty). */
  syncContractors(company?: Company): Promise<{ ok: boolean; created: number; error?: string }> {
    const q = company ? `?company=${company}` : '';
    return request(`/api/contractors/sync${q}`, { method: 'POST', body: '{}' });
  },

  /** Сохранить банковские реквизиты контрагента (р/с, БИК). */
  updateContractorRequisites(id: string, bank_account: string | null, bik: string | null): Promise<{ updated: boolean }> {
    return request('/api/contractors', {
      method: 'PATCH',
      body: JSON.stringify({ id, bank_account, bik }),
    });
  },

  generateInvoice(body: {
    contractor_id: string;
    amount: string | number;
    description?: string | null;
    due_date?: string | null;
  }): Promise<InvoiceGenerateResponse> {
    return request<InvoiceGenerateResponse>('/api/invoices/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // ── Кредиты (/api/loans) ──────────────────────────────────────────────────

  loans(company?: Company): Promise<LoansResponse> {
    const q = company ? `?company=${company}` : '';
    return request<LoansResponse>(`/api/loans${q}`);
  },

  // ── AI-оркестратор (/api/ai/commands) — US-105 ────────────────────────────

  aiCommand(command: string): Promise<AiCommandResponse> {
    return request<AiCommandResponse>('/api/ai/commands', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  },

  aiCommandApprove(id: string, approved: boolean): Promise<AiCommandApproveResponse> {
    return request<AiCommandApproveResponse>('/api/ai/commands/approve', {
      method: 'POST',
      body: JSON.stringify({ id, approved }),
    });
  },

  /** Единый AI: вернёт совет (kind:'answer') ИЛИ действие на подтверждение (kind:'action'). */
  aiAssistant(body: {
    question: string;
    entity_id?: string | null;
    from?: string | null;
    to?: string | null;
    context?: string | null;
    history?: string | null;
  }): Promise<AiAssistantResponse> {
    return request<AiAssistantResponse>('/api/ai/assistant', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Расшифровка голоса: аудио base64 → текст (Deepgram на бэке). */
  transcribe(audioBase64: string, mime: string): Promise<TranscribeResponse> {
    return request<TranscribeResponse>('/api/ai/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio_base64: audioBase64, mime }),
    });
  },

  /** Распознать операции со скриншота карты (Vision). */
  importImage(imageBase64: string, mime: string): Promise<ImportImageResponse> {
    return request<ImportImageResponse>('/api/ai/import-image', {
      method: 'POST',
      body: JSON.stringify({ image_base64: imageBase64, mime }),
    });
  },

  /** Занести распознанные операции (после проверки). */
  importConfirm(transactions: ImportedTxItem[], card = 'lilia'): Promise<ImportConfirmResponse> {
    return request<ImportConfirmResponse>('/api/ai/import/confirm', {
      method: 'POST',
      body: JSON.stringify({ transactions, card }),
    });
  },

  // ── Деньги в пути (/api/analytics/pnl/in-transit) — US-104 ─────────────────

  inTransit(entity: PnlEntity, period: string): Promise<InTransitResponse> {
    const q = new URLSearchParams({ entity, period }).toString();
    return request<InTransitResponse>(`/api/analytics/pnl/in-transit?${q}`);
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
