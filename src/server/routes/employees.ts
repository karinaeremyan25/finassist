/**
 * ФОТ (SPEC_FinAssist_v2.1 US-101). Роутер делает exact-match без path-params,
 * поэтому id передаётся в query (?id=) или в теле.
 *
 *   GET   /api/employees?company=ip&status=active&period=2026-06
 *   GET   /api/employees/transactions?id=<uuid>
 *   POST  /api/employees                 — создать сотрудника
 *   PATCH /api/employees                 — обновить (id в теле)
 *
 * Авторизация: resolveWebAppUser. Суммы — копейки (bigint), bigintReplacer
 * сериализует. Все три роли имеют одинаковый доступ.
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import {
  listEmployees,
  getEmployee,
  getEmployeeTransactions,
  getPayrollMonthly,
  createEmployee,
  updateEmployee,
} from '../../db/repositories/employees.js';
import { toKopecks } from '../../utils/money.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'employees' });

/** Текущий месяц в МСК (UTC+3) как 'YYYY-MM'. */
function currentMonthMsk(): string {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, '0')}`;
}

const CompanySchema = z.enum(['ip', 'ooo']);
const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/);

const ListQuerySchema = z.object({
  company: CompanySchema.optional(),
  status: z.enum(['active', 'on_leave', 'dismissed']).optional(),
  period: PeriodSchema.optional(),
});

function invalidRequest(message: string): ApiResponse {
  return { status: 400, body: { error: { code: 'invalid_request', message } } };
}

// ── GET /api/employees ─────────────────────────────────────────────────────

export const employeesListHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidRequest('Неверные параметры запроса');

    const period = parsed.data.period ?? currentMonthMsk();
    const employees = await listEmployees(
      period,
      parsed.data.company ?? null,
      parsed.data.status ?? null
    );

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'employees_list', count: employees.length, latency_ms: Date.now() - start },
      'employees_list_ok'
    );

    return {
      status: 200,
      body: {
        period,
        data: employees.map((e) => ({
          id: e.id,
          company_id: e.companyId,
          full_name: e.fullName,
          position: e.position,
          status: e.status,
          salary_monthly: e.salaryMonthly,
          total_paid_current: e.paidCurrent,
          total_paid_prev: e.paidPrev,
          balance: e.balance,
        })),
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'employees_list', latency_ms: Date.now() - start }, 'employees_list_error');
    return { status: 200, body: { period: currentMonthMsk(), data: [] } };
  }
};

// ── GET /api/employees/analytics — помесячный ФОТ + % изменения ─────────────

export const employeesAnalyticsHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const months = await getPayrollMonthly(6);

    const n = months.length;
    const current = n > 0 ? months[n - 1]!.total : 0n;
    const prev = n > 1 ? months[n - 2]!.total : 0n;
    const deltaPct =
      prev === 0n ? null : Math.round((Number(current - prev) / Number(prev)) * 1000) / 10;
    const avg =
      n > 0 ? months.reduce((s, m) => s + m.total, 0n) / BigInt(n) : 0n;

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'employees_analytics', latency_ms: Date.now() - start },
      'employees_analytics_ok'
    );
    return {
      status: 200,
      body: {
        months: months.map((m) => ({ month: m.month, total: m.total })),
        current_month: current,
        prev_month: prev,
        delta_pct: deltaPct,
        avg_month: avg,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'employees_analytics', latency_ms: Date.now() - start }, 'employees_analytics_error');
    return { status: 200, body: { months: [], current_month: 0, prev_month: 0, delta_pct: null, avg_month: 0 } };
  }
};

// ── GET /api/employees/transactions?id= ────────────────────────────────────

const EmpTxQuerySchema = z.object({ id: z.string().uuid() });

export const employeeTransactionsHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = EmpTxQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidRequest('Параметр id (uuid) обязателен');

    const employee = await getEmployee(parsed.data.id);
    if (employee === null) {
      return { status: 404, body: { error: { code: 'not_found', message: 'Сотрудник не найден' } } };
    }
    const txs = await getEmployeeTransactions(employee);

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'employee_tx', count: txs.length, latency_ms: Date.now() - start },
      'employee_tx_ok'
    );

    return {
      status: 200,
      body: {
        employee: { id: employee.id, full_name: employee.fullName, position: employee.position },
        data: txs.map((t) => ({
          id: t.id,
          amount: t.flowType === 'expense' ? -t.amount : t.amount,
          flow_type: t.flowType,
          pnl_category: t.pnlCategory,
          description: t.description,
          counterparty: t.counterparty,
          date_transaction: t.occurredAt,
          tx_status: t.txStatus,
          // external_id → клик на чек из Точки
          tochka_transaction_id: t.externalId,
        })),
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'employee_tx', latency_ms: Date.now() - start }, 'employee_tx_error');
    throw err;
  }
};

// ── POST /api/employees ────────────────────────────────────────────────────

const CreateBodySchema = z.object({
  company_id: CompanySchema,
  full_name: z.string().min(1).max(200),
  position: z.string().max(200).nullish(),
  salary_monthly: z.union([z.string(), z.number()]).nullish(),
  match_pattern: z.string().max(200).nullish(),
});

export const employeeCreateHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = CreateBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(parsed.error.errors[0]?.message ?? 'Неверное тело запроса');

    const d = parsed.data;
    const salary =
      d.salary_monthly === null || d.salary_monthly === undefined ? null : toKopecks(d.salary_monthly);

    const id = await createEmployee({
      companyId: d.company_id,
      fullName: d.full_name,
      position: d.position ?? null,
      salaryMonthly: salary,
      matchPattern: d.match_pattern ?? null,
    });

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'employee_create', id, latency_ms: Date.now() - start },
      'employee_create_ok'
    );
    return { status: 200, body: { id } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'employee_create', latency_ms: Date.now() - start }, 'employee_create_error');
    return invalidRequest('Не удалось создать сотрудника');
  }
};

// ── PATCH /api/employees (id в теле) ───────────────────────────────────────

const UpdateBodySchema = z.object({
  id: z.string().uuid(),
  full_name: z.string().min(1).max(200).optional(),
  position: z.string().max(200).nullish(),
  salary_monthly: z.union([z.string(), z.number()]).nullish(),
  match_pattern: z.string().max(200).nullish(),
  status: z.enum(['active', 'on_leave', 'dismissed']).optional(),
});

export const employeeUpdateHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = UpdateBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(parsed.error.errors[0]?.message ?? 'Неверное тело запроса');

    const d = parsed.data;
    const patch: Parameters<typeof updateEmployee>[1] = {};
    if (d.full_name !== undefined) patch.fullName = d.full_name;
    if (d.position !== undefined) patch.position = d.position;
    if (d.salary_monthly !== undefined) {
      patch.salaryMonthly = d.salary_monthly === null ? null : toKopecks(d.salary_monthly);
    }
    if (d.match_pattern !== undefined) patch.matchPattern = d.match_pattern;
    if (d.status !== undefined) patch.status = d.status;

    const ok = await updateEmployee(d.id, patch);
    if (!ok) return { status: 404, body: { error: { code: 'not_found', message: 'Сотрудник не найден' } } };

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'employee_update', id: d.id, latency_ms: Date.now() - start },
      'employee_update_ok'
    );
    return { status: 200, body: { id: d.id, updated: true } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'employee_update', latency_ms: Date.now() - start }, 'employee_update_error');
    return invalidRequest('Не удалось обновить сотрудника');
  }
};

/** Единый handler для /api/employees — диспатч по методу (как adminUsersHandler). */
export const employeesHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  if (req.method === 'POST') return employeeCreateHandler(req);
  if (req.method === 'PATCH') return employeeUpdateHandler(req);
  return employeesListHandler(req);
};
