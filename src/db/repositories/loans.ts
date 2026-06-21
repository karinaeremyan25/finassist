/**
 * Репозиторий «Кредиты» — расходные операции с pnl_category='loan',
 * сгруппированные по кредитору (counterparty). Read-only. Суммы — копейки.
 * Запросы строго последовательны (pgBouncer transaction mode).
 */

import { sql } from '../client.js';
import { ENTITY_IDS } from './pnl.js';

export type Company = 'ip' | 'ooo';

export interface LoanPayment {
  id: string;
  amount: bigint;
  description: string | null;
  occurredAt: string;
  externalId: string | null;
}

export interface LoanCreditor {
  name: string;
  totalPaid: bigint;
  count: number;
  firstDate: string;
  lastDate: string;
  payments: LoanPayment[];
}

/** Кредиторы с суммами выплат и списком платежей (pnl_category='loan'). */
export async function listLoans(company: Company | null): Promise<LoanCreditor[]> {
  const entityFilter =
    company === 'ip'
      ? sql`AND t.entity_id = ${ENTITY_IDS.ip}`
      : company === 'ooo'
        ? sql`AND t.entity_id = ${ENTITY_IDS.ooo}`
        : sql``;

  const rows = await sql<{
    counterparty: string | null;
    id: string;
    amount_rub: bigint;
    description: string | null;
    occurred_at: string;
    external_id: string | null;
  }[]>`
    SELECT t.counterparty, t.id, t.amount_rub, t.description,
           t.occurred_at::text AS occurred_at, t.external_id
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND t.pnl_category = 'loan'
      ${entityFilter}
    ORDER BY t.occurred_at DESC
  `;

  const byCreditor = new Map<string, LoanCreditor>();
  for (const r of rows) {
    const name = r.counterparty ?? 'Без названия';
    let c = byCreditor.get(name);
    if (c === undefined) {
      c = { name, totalPaid: 0n, count: 0, firstDate: r.occurred_at, lastDate: r.occurred_at, payments: [] };
      byCreditor.set(name, c);
    }
    c.totalPaid += r.amount_rub;
    c.count += 1;
    if (r.occurred_at < c.firstDate) c.firstDate = r.occurred_at;
    if (r.occurred_at > c.lastDate) c.lastDate = r.occurred_at;
    c.payments.push({
      id: r.id,
      amount: r.amount_rub,
      description: r.description,
      occurredAt: r.occurred_at,
      externalId: r.external_id,
    });
  }

  return Array.from(byCreditor.values()).sort((a, b) => (a.totalPaid < b.totalPaid ? 1 : -1));
}
