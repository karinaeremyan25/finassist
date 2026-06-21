/**
 * Репозиторий ФОТ (SPEC_FinAssist_v2.1 US-101).
 *
 * Транзакции НЕ хранят employee_id обязательно — сотрудник сопоставляется либо
 * явной связью transactions.employee_id, либо по match_pattern (подстрока в
 * counterparty). Это повторяет существующий подход PAYROLL_PAYEES.
 *
 * Все суммы — копейки (BIGINT → bigint). Запросы строго последовательны
 * (pgBouncer transaction mode).
 */

import { sql } from '../client.js';
import { ENTITY_IDS } from './pnl.js';

export type Company = 'ip' | 'ooo';
export type EmployeeStatus = 'active' | 'on_leave' | 'dismissed';

export interface EmployeeRow {
  id: string;
  companyId: Company;
  fullName: string;
  position: string | null;
  salaryMonthly: bigint | null;
  matchPattern: string | null;
  status: EmployeeStatus;
}

export interface EmployeeWithTotals extends EmployeeRow {
  paidCurrent: bigint;
  paidPrev: bigint;
  /** salary_monthly − paidCurrent. null, если оклад не задан (edge case #1). */
  balance: bigint | null;
}

/** 'YYYY-MM' → границы текущего и предыдущего месяца как даты 'YYYY-MM-DD'. */
function monthRange(period: string): {
  curFrom: string;
  curTo: string;
  prevFrom: string;
  prevTo: string;
} {
  const [yStr, mStr] = period.split('-');
  const year = parseInt(yStr!, 10);
  const month = parseInt(mStr!, 10);

  const pad = (n: number): string => String(n).padStart(2, '0');
  const firstOf = (y: number, m: number): string => `${y}-${pad(m)}-01`;

  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };

  return {
    curFrom: firstOf(year, month),
    curTo: firstOf(next.y, next.m),
    prevFrom: firstOf(prev.y, prev.m),
    prevTo: firstOf(year, month),
  };
}

interface EmployeeAggRow {
  id: string;
  company_id: Company;
  full_name: string;
  position: string | null;
  salary_monthly: bigint | null;
  match_pattern: string | null;
  status: EmployeeStatus;
  paid_current: bigint;
  paid_prev: bigint;
}

/**
 * Список сотрудников с суммами выплат за текущий и предыдущий месяц.
 * company: фильтр по юрлицу (null = оба). status: 'active' по умолчанию (null = все).
 */
export async function listEmployees(
  period: string,
  company: Company | null,
  status: EmployeeStatus | null
): Promise<EmployeeWithTotals[]> {
  const { curFrom, curTo, prevFrom, prevTo } = monthRange(period);

  const companyFilter = company !== null ? sql`AND e.company_id = ${company}` : sql``;
  const statusFilter = status !== null ? sql`AND e.status = ${status}` : sql``;

  const rows = await sql<EmployeeAggRow[]>`
    SELECT
      e.id,
      e.company_id,
      e.full_name,
      e.position,
      e.salary_monthly,
      e.match_pattern,
      e.status,
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.occurred_at >= ${curFrom} AND t.occurred_at < ${curTo}
      ), 0)::bigint AS paid_current,
      COALESCE(SUM(t.amount_rub) FILTER (
        WHERE t.occurred_at >= ${prevFrom} AND t.occurred_at < ${prevTo}
      ), 0)::bigint AS paid_prev
    FROM employees e
    LEFT JOIN transactions t
      ON t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND (
        t.employee_id = e.id
        OR (
          e.match_pattern IS NOT NULL AND e.match_pattern <> ''
          AND t.counterparty ILIKE '%' || e.match_pattern || '%'
        )
      )
    WHERE 1 = 1
      ${companyFilter}
      ${statusFilter}
    GROUP BY e.id
    ORDER BY e.full_name
  `;

  return rows.map((r): EmployeeWithTotals => ({
    id: r.id,
    companyId: r.company_id,
    fullName: r.full_name,
    position: r.position,
    salaryMonthly: r.salary_monthly,
    matchPattern: r.match_pattern,
    status: r.status,
    paidCurrent: r.paid_current,
    paidPrev: r.paid_prev,
    balance: r.salary_monthly === null ? null : r.salary_monthly - r.paid_current,
  }));
}

/**
 * Активные сотрудники с непустым match_pattern — для классификатора:
 * перевод этому человеку (counterparty совпал) → ФОТ автоматически.
 */
export async function getActivePayrollPatterns(): Promise<{ id: string; pattern: string }[]> {
  const rows = await sql<{ id: string; match_pattern: string }[]>`
    SELECT id, match_pattern
    FROM employees
    WHERE status = 'active'
      AND match_pattern IS NOT NULL
      AND length(trim(match_pattern)) > 0
  `;
  return rows.map((r) => ({ id: r.id, pattern: r.match_pattern.toLowerCase() }));
}

/** Один сотрудник по id (или null). */
export async function getEmployee(id: string): Promise<EmployeeRow | null> {
  const rows = await sql<{
    id: string;
    company_id: Company;
    full_name: string;
    position: string | null;
    salary_monthly: bigint | null;
    match_pattern: string | null;
    status: EmployeeStatus;
  }[]>`
    SELECT id, company_id, full_name, position, salary_monthly, match_pattern, status
    FROM employees
    WHERE id = ${id}::uuid
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    companyId: r.company_id,
    fullName: r.full_name,
    position: r.position,
    salaryMonthly: r.salary_monthly,
    matchPattern: r.match_pattern,
    status: r.status,
  };
}

export interface EmployeeTxRow {
  id: string;
  amount: bigint;
  flowType: 'income' | 'expense';
  pnlCategory: string | null;
  description: string | null;
  counterparty: string | null;
  occurredAt: string;
  txStatus: string;
  externalId: string | null;
}

/**
 * Операции по сотруднику (выплаты/авансы): явная связь employee_id ИЛИ match_pattern.
 * externalId — для клика на чек из Точки.
 */
export async function getEmployeeTransactions(emp: EmployeeRow): Promise<EmployeeTxRow[]> {
  const patternFilter =
    emp.matchPattern !== null && emp.matchPattern !== ''
      ? sql`OR t.counterparty ILIKE ${'%' + emp.matchPattern + '%'}`
      : sql``;

  const rows = await sql<{
    id: string;
    amount_rub: bigint;
    flow_type: 'income' | 'expense';
    pnl_category: string | null;
    description: string | null;
    counterparty: string | null;
    occurred_at: string;
    tx_status: string;
    external_id: string | null;
  }[]>`
    SELECT
      t.id, t.amount_rub, t.flow_type, t.pnl_category, t.description,
      t.counterparty, t.occurred_at::text AS occurred_at, t.tx_status, t.external_id
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND (t.employee_id = ${emp.id}::uuid ${patternFilter})
    ORDER BY t.occurred_at DESC
    LIMIT 200
  `;

  return rows.map((r): EmployeeTxRow => ({
    id: r.id,
    amount: r.amount_rub,
    flowType: r.flow_type,
    pnlCategory: r.pnl_category,
    description: r.description,
    counterparty: r.counterparty,
    occurredAt: r.occurred_at,
    txStatus: r.tx_status,
    externalId: r.external_id,
  }));
}

export interface CreateEmployeeInput {
  companyId: Company;
  fullName: string;
  position: string | null;
  salaryMonthly: bigint | null;
  matchPattern: string | null;
}

/** Создаёт сотрудника, возвращает его id. */
export async function createEmployee(input: CreateEmployeeInput): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO employees (company_id, full_name, position, salary_monthly, match_pattern)
    VALUES (
      ${input.companyId}, ${input.fullName}, ${input.position},
      ${input.salaryMonthly}, ${input.matchPattern}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

export interface UpdateEmployeePatch {
  fullName?: string;
  position?: string | null;
  salaryMonthly?: bigint | null;
  matchPattern?: string | null;
  status?: EmployeeStatus;
}

/** Точечное обновление сотрудника. Возвращает true, если запись существовала. */
export async function updateEmployee(id: string, patch: UpdateEmployeePatch): Promise<boolean> {
  const sets: ReturnType<typeof sql>[] = [];
  if (patch.fullName !== undefined) sets.push(sql`full_name = ${patch.fullName}`);
  if (patch.position !== undefined) sets.push(sql`position = ${patch.position}`);
  if (patch.salaryMonthly !== undefined) sets.push(sql`salary_monthly = ${patch.salaryMonthly}`);
  if (patch.matchPattern !== undefined) sets.push(sql`match_pattern = ${patch.matchPattern}`);
  if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
  if (sets.length === 0) return true;

  // Собираем SET-список через запятую.
  let setExpr = sets[0]!;
  for (let i = 1; i < sets.length; i++) {
    setExpr = sql`${setExpr}, ${sets[i]!}`;
  }

  const rows = await sql<{ id: string }[]>`
    UPDATE employees SET ${setExpr}, updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING id
  `;
  return rows.length > 0;
}
