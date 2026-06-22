/**
 * Репозиторий контрагентов и их остатков (SPEC_FinAssist_v2.1 US-102).
 *
 * Остаток задолженности = Σ(счета, статус != cancelled) − Σ(платежи контрагенту).
 * Платёж сопоставляется с контрагентом по transactions.contractor_id ИЛИ по
 * match_pattern (подстрока в counterparty). Все суммы — копейки (bigint).
 * Запросы строго последовательны (pgBouncer transaction mode).
 */

import { sql } from '../client.js';
import { ENTITY_IDS } from './pnl.js';

export type Company = 'ip' | 'ooo';
export type ContractorType = 'individual' | 'company' | 'self_employed';
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'cancelled';

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  amount: bigint;
  description: string | null;
  dueDate: string | null;
  status: InvoiceStatus;
  pdfUrl: string | null;
  datePaid: string | null;
  createdAt: string;
}

export interface ContractorPaymentRow {
  id: string;
  /** Сумма со знаком: поступление от контрагента +, оплата контрагенту −. */
  amount: bigint;
  flowType: 'income' | 'expense';
  description: string | null;
  occurredAt: string;
  externalId: string | null;
}

/** entity_id → 'ip'|'ooo'|null (по seed-константам). */
function entityToCompany(entityId: string | null): Company | null {
  if (entityId === ENTITY_IDS.ip) return 'ip';
  if (entityId === ENTITY_IDS.ooo) return 'ooo';
  return null;
}

export interface ContractorWithBalance {
  id: string;
  companyId: Company;
  name: string;
  phone: string | null;
  email: string | null;
  inn: string | null;
  bankAccount: string | null;
  bik: string | null;
  contractorType: ContractorType;
  status: 'active' | 'archived';
  matchPattern: string | null;
  totalInvoiced: bigint;
  totalPaid: bigint;
  balanceOwed: bigint;
  invoices: InvoiceRow[];
  payments: ContractorPaymentRow[];
}

interface ContractorRaw {
  id: string;
  company_id: Company;
  name: string;
  phone: string | null;
  email: string | null;
  inn: string | null;
  bank_account: string | null;
  bik: string | null;
  contractor_type: ContractorType;
  status: 'active' | 'archived';
  match_pattern: string | null;
}

/**
 * Список контрагентов компании с вложенными счетами, платежами и остатком.
 * Сделано последовательными запросами: контрагенты → счета → платежи, затем
 * сборка в JS (таблицы небольшие).
 */
export async function listContractorsWithBalance(
  company: Company | null
): Promise<ContractorWithBalance[]> {
  const companyFilter = company !== null ? sql`WHERE c.company_id = ${company}` : sql``;

  const contractors = await sql<ContractorRaw[]>`
    SELECT c.id, c.company_id, c.name, c.phone, c.email, c.inn,
           c.bank_account, c.bik, c.contractor_type, c.status, c.match_pattern
    FROM contractors c
    ${companyFilter}
    ORDER BY c.name
  `;

  if (contractors.length === 0) return [];

  const ids = contractors.map((c) => c.id);

  // Все счета этих контрагентов одним запросом.
  const invoiceRows = await sql<{
    id: string;
    contractor_id: string;
    invoice_number: string;
    amount: bigint;
    description: string | null;
    due_date: string | null;
    status: InvoiceStatus;
    pdf_url: string | null;
    date_paid: string | null;
    created_at: string;
  }[]>`
    SELECT id, contractor_id, invoice_number, amount, description,
           due_date::text AS due_date, status, pdf_url,
           date_paid::text AS date_paid, created_at::text AS created_at
    FROM invoices
    WHERE contractor_id = ANY(${ids}::uuid[])
    ORDER BY created_at DESC
  `;

  // Платежи: по явной связи contractor_id ИЛИ по совпадению counterparty с
  // match_pattern контрагента (контрагенты, заведённые из выписки Точки, хранят
  // counterparty в match_pattern). Один запрос, разнос по контрагентам в JS.
  const patterns = contractors
    .map((c) => c.match_pattern)
    .filter((p): p is string => p !== null && p.trim().length > 0);

  const paymentRows = await sql<{
    contractor_id: string | null;
    counterparty: string | null;
    id: string;
    amount_rub: bigint;
    flow_type: 'income' | 'expense';
    description: string | null;
    occurred_at: string;
    external_id: string | null;
  }[]>`
    SELECT t.contractor_id, t.counterparty, t.id, t.amount_rub, t.flow_type, t.description,
           t.occurred_at::text AS occurred_at, t.external_id
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND (
        t.contractor_id = ANY(${ids}::uuid[])
        OR t.counterparty = ANY(${patterns}::text[])
      )
    ORDER BY t.occurred_at DESC
    LIMIT 2000
  `;

  // Карта counterparty(lower) → contractorId для разноса платежей без явной связи.
  const patternToContractor = new Map<string, string>();
  for (const c of contractors) {
    if (c.match_pattern !== null && c.match_pattern.trim().length > 0) {
      patternToContractor.set(c.match_pattern.toLowerCase(), c.id);
    }
  }
  const idSet = new Set(ids);

  const invByContractor = new Map<string, InvoiceRow[]>();
  for (const r of invoiceRows) {
    const list = invByContractor.get(r.contractor_id) ?? [];
    list.push({
      id: r.id,
      invoiceNumber: r.invoice_number,
      amount: r.amount,
      description: r.description,
      dueDate: r.due_date,
      status: r.status,
      pdfUrl: r.pdf_url,
      datePaid: r.date_paid,
      createdAt: r.created_at,
    });
    invByContractor.set(r.contractor_id, list);
  }

  const payByContractor = new Map<string, ContractorPaymentRow[]>();
  for (const r of paymentRows) {
    // Приоритет — явная связь contractor_id, иначе разносим по match_pattern.
    const cid =
      r.contractor_id !== null && idSet.has(r.contractor_id)
        ? r.contractor_id
        : r.counterparty !== null
          ? patternToContractor.get(r.counterparty.toLowerCase())
          : undefined;
    if (cid === undefined) continue;
    const list = payByContractor.get(cid) ?? [];
    list.push({
      id: r.id,
      // Знак: поступление от контрагента +, оплата контрагенту −.
      amount: r.flow_type === 'expense' ? -r.amount_rub : r.amount_rub,
      flowType: r.flow_type,
      description: r.description,
      occurredAt: r.occurred_at,
      externalId: r.external_id,
    });
    payByContractor.set(cid, list);
  }

  return contractors.map((c): ContractorWithBalance => {
    const invoices = invByContractor.get(c.id) ?? [];
    const payments = payByContractor.get(c.id) ?? [];
    const totalInvoiced = invoices
      .filter((i) => i.status !== 'cancelled')
      .reduce((s, i) => s + i.amount, 0n);
    // «Оплачено» = поступления ОТ контрагента (income, положительные суммы).
    const totalPaid = payments
      .filter((p) => p.flowType === 'income')
      .reduce((s, p) => s + p.amount, 0n);
    return {
      id: c.id,
      companyId: c.company_id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      inn: c.inn,
      bankAccount: c.bank_account,
      bik: c.bik,
      contractorType: c.contractor_type,
      status: c.status,
      matchPattern: c.match_pattern,
      totalInvoiced,
      totalPaid,
      balanceOwed: totalInvoiced - totalPaid,
      invoices,
      payments,
    };
  });
}

export interface CreateContractorInput {
  companyId: Company;
  name: string;
  phone: string | null;
  email: string | null;
  inn: string | null;
  contractorType: ContractorType;
  matchPattern: string | null;
}

/** Создаёт контрагента, возвращает id. */
export async function createContractor(input: CreateContractorInput): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO contractors (company_id, name, phone, email, inn, contractor_type, match_pattern)
    VALUES (
      ${input.companyId}, ${input.name}, ${input.phone}, ${input.email},
      ${input.inn}, ${input.contractorType}, ${input.matchPattern}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Заводит контрагентов из выписки Точки: группирует операции по counterparty,
 * создаёт запись на каждого нового (name=counterparty, match_pattern=counterparty,
 * company по entity_id). Идемпотентно: существующие (по company+lower(name))
 * пропускаются. Возвращает число созданных.
 *
 * Сервисные «контрагенты» (сам банк) исключаем, чтобы не зашумлять список.
 */
export async function deriveContractorsFromTransactions(company: Company | null): Promise<number> {
  const entityIds =
    company === 'ip'
      ? [ENTITY_IDS.ip]
      : company === 'ooo'
        ? [ENTITY_IDS.ooo]
        : [ENTITY_IDS.ip, ENTITY_IDS.ooo];

  const rows = await sql<{ entity_id: string; counterparty: string }[]>`
    SELECT t.entity_id::text AS entity_id, t.counterparty
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.counterparty IS NOT NULL
      AND length(trim(t.counterparty)) > 2
      AND t.counterparty NOT ILIKE '%банк точка%'
      AND t.entity_id = ANY(${entityIds})
    GROUP BY t.entity_id, t.counterparty
    ORDER BY t.counterparty
  `;

  let created = 0;
  for (const r of rows) {
    const comp = entityToCompany(r.entity_id);
    if (comp === null) continue;
    const res = await sql<{ id: string }[]>`
      INSERT INTO contractors (company_id, name, contractor_type, match_pattern)
      SELECT ${comp}, ${r.counterparty}, 'company', ${r.counterparty}
      WHERE NOT EXISTS (
        SELECT 1 FROM contractors c
        WHERE c.company_id = ${comp} AND lower(c.name) = lower(${r.counterparty})
      )
      RETURNING id
    `;
    if (res.length > 0) created += 1;
  }
  return created;
}

/** Обновляет банковские реквизиты контрагента. true, если запись существовала. */
export async function updateContractorRequisites(
  id: string,
  bankAccount: string | null,
  bik: string | null
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE contractors
    SET bank_account = ${bankAccount}, bik = ${bik}, updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Ищет получателя платежа по имени среди контрагентов (есть реквизиты) и сотрудников.
 * Для AI-платёжки: достаёт name + inn + р/с + БИК из базы. null, если не найден.
 */
export async function findPayeeByName(
  name: string
): Promise<{ name: string; inn: string | null; bankAccount: string | null; bik: string | null; kind: 'contractor' | 'employee' } | null> {
  const like = `%${name.trim()}%`;
  const c = await sql<{ name: string; inn: string | null; bank_account: string | null; bik: string | null }[]>`
    SELECT name, inn, bank_account, bik FROM contractors
    WHERE name ILIKE ${like} AND status = 'active'
    ORDER BY char_length(name) LIMIT 1
  `;
  if (c[0]) return { name: c[0].name, inn: c[0].inn, bankAccount: c[0].bank_account, bik: c[0].bik, kind: 'contractor' };

  const e = await sql<{ full_name: string }[]>`
    SELECT full_name FROM employees
    WHERE full_name ILIKE ${like} AND status = 'active'
    ORDER BY char_length(full_name) LIMIT 1
  `;
  if (e[0]) return { name: e[0].full_name, inn: null, bankAccount: null, bik: null, kind: 'employee' };

  return null;
}

/** Находит контрагента ООО по точному/похожему имени (для AI-оркестратора). */
export async function findContractorByName(
  name: string,
  company: Company
): Promise<{ id: string; name: string } | null> {
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM contractors
    WHERE company_id = ${company}
      AND name ILIKE ${'%' + name + '%'}
      AND status = 'active'
    ORDER BY char_length(name)
    LIMIT 1
  `;
  return rows[0] ?? null;
}
