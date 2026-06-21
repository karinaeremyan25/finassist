/**
 * Репозиторий счетов (SPEC_FinAssist_v2.1 US-102). Счета выставляет только ООО
 * (edge case #5). Номера — последовательные строки "1","2",... в рамках ООО.
 * Суммы — копейки (bigint). Запросы строго последовательны.
 */

import { sql } from '../client.js';
import type { InvoiceStatus } from './contractors.js';

export interface CreatedInvoice {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  amount: bigint;
  contractorId: string;
}

/**
 * Следующий номер счёта ООО = max(числовой invoice_number) + 1.
 * Нечисловые номера игнорируются при поиске максимума.
 */
async function nextInvoiceNumber(): Promise<string> {
  const rows = await sql<{ max_num: number | null }[]>`
    SELECT MAX((invoice_number)::int) AS max_num
    FROM invoices
    WHERE company_id = 'ooo' AND invoice_number ~ '^[0-9]+$'
  `;
  const max = rows[0]?.max_num ?? 0;
  return String(max + 1);
}

export interface CreateInvoiceInput {
  contractorId: string;
  amount: bigint;
  description: string | null;
  dueDate: string | null; // 'YYYY-MM-DD' или null
  createdBy: string | null;
}

/** Создаёт счёт ООО в статусе draft с автогенерируемым номером. */
export async function createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
  const number = await nextInvoiceNumber();

  const rows = await sql<{
    id: string;
    invoice_number: string;
    status: InvoiceStatus;
    amount: bigint;
    contractor_id: string;
  }[]>`
    INSERT INTO invoices (company_id, invoice_number, contractor_id, amount, description, due_date, status, created_by)
    VALUES ('ooo', ${number}, ${input.contractorId}::uuid, ${input.amount},
            ${input.description}, ${input.dueDate}, 'draft', ${input.createdBy}::uuid)
    RETURNING id, invoice_number, status, amount, contractor_id
  `;
  const r = rows[0]!;
  return {
    id: r.id,
    invoiceNumber: r.invoice_number,
    status: r.status,
    amount: r.amount,
    contractorId: r.contractor_id,
  };
}

/** Меняет статус счёта (draft→sent→paid / cancelled). Возвращает true, если найден. */
export async function setInvoiceStatus(
  id: string,
  status: InvoiceStatus
): Promise<boolean> {
  const datePaid = status === 'paid' ? sql`NOW()` : sql`date_paid`;
  const rows = await sql<{ id: string }[]>`
    UPDATE invoices
    SET status = ${status}, date_paid = ${datePaid}, updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING id
  `;
  return rows.length > 0;
}
