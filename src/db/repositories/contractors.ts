/**
 * Репозиторий контрагентов и их остатков (SPEC_FinAssist_v2.1 US-102).
 *
 * Остаток задолженности = Σ(счета, статус != cancelled) − Σ(платежи контрагенту).
 * Платёж сопоставляется с контрагентом по transactions.contractor_id ИЛИ по
 * match_pattern (подстрока в counterparty). Все суммы — копейки (bigint).
 * Запросы строго последовательны (pgBouncer transaction mode).
 */

import { sql } from '../client.js';

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
  amount: bigint;
  description: string | null;
  occurredAt: string;
  externalId: string | null;
}

export interface ContractorWithBalance {
  id: string;
  companyId: Company;
  name: string;
  phone: string | null;
  email: string | null;
  inn: string | null;
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
           c.contractor_type, c.status, c.match_pattern
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

  // Платежи: по contractor_id ИЛИ по match_pattern. Делаем один запрос по
  // contractor_id-связи, и отдельно — по match_pattern (если задан).
  const paymentRows = await sql<{
    contractor_id: string;
    id: string;
    amount_rub: bigint;
    description: string | null;
    occurred_at: string;
    external_id: string | null;
  }[]>`
    SELECT t.contractor_id, t.id, t.amount_rub, t.description,
           t.occurred_at::text AS occurred_at, t.external_id
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.contractor_id = ANY(${ids}::uuid[])
    ORDER BY t.occurred_at DESC
  `;

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
    const list = payByContractor.get(r.contractor_id) ?? [];
    list.push({
      id: r.id,
      amount: r.amount_rub,
      description: r.description,
      occurredAt: r.occurred_at,
      externalId: r.external_id,
    });
    payByContractor.set(r.contractor_id, list);
  }

  return contractors.map((c): ContractorWithBalance => {
    const invoices = invByContractor.get(c.id) ?? [];
    const payments = payByContractor.get(c.id) ?? [];
    const totalInvoiced = invoices
      .filter((i) => i.status !== 'cancelled')
      .reduce((s, i) => s + i.amount, 0n);
    const totalPaid = payments.reduce((s, p) => s + p.amount, 0n);
    return {
      id: c.id,
      companyId: c.company_id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      inn: c.inn,
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
