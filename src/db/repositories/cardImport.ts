/**
 * Импорт операций с физ-карты по скриншоту (карта Лилианы и др. — API нет).
 * AI-vision распознаёт операции, пользователь подтверждает, мы заносим их как
 * расходы/доходы по ИП с дедупликацией. Классификация — через справочник ФОТ
 * (перевод сотруднику → payroll) и выученные правила.
 *
 * created_by — BIGINT telegram_id (как в tochkaSync). Суммы — копейки.
 */

import { sql } from '../client.js';
import { ENTITY_IDS } from './pnl.js';
import { getActivePayrollPatterns } from './employees.js';
import { listRules, matchRule } from './categoryRules.js';

/** Получить или создать источник физ-карты (entity = ИП). Возвращает id. */
export async function ensureCardSource(code: string, displayName: string): Promise<string> {
  const existing = await sql<{ id: string }[]>`SELECT id FROM sources WHERE code = ${code}`;
  if (existing[0]) return existing[0].id;
  const ins = await sql<{ id: string }[]>`
    INSERT INTO sources (code, display_name, entity_id)
    VALUES (${code}, ${displayName}, ${ENTITY_IDS.ip})
    RETURNING id
  `;
  return ins[0]!.id;
}

export interface ImportedTx {
  date: string; // YYYY-MM-DD
  amountKop: bigint;
  direction: 'in' | 'out';
  counterparty: string;
  description: string | null;
}

export interface ImportResult {
  created: number;
  skipped: number;
  payroll: number;
  totalKop: bigint;
}

/**
 * Заносит распознанные операции. Дедуп по external_id = card:<code>:<date>:<kop>:<cp>.
 * pnl_category: сотрудник из справочника ФОТ → payroll; иначе правило; иначе NULL.
 */
export async function importCardTransactions(
  txs: ImportedTx[],
  cardCode: string,
  cardName: string,
  createdByTgId: bigint
): Promise<ImportResult> {
  const sourceId = await ensureCardSource(cardCode, cardName);

  // Классификационные слои (загружаем один раз).
  let payroll: { id: string; pattern: string }[] = [];
  let rules: Awaited<ReturnType<typeof listRules>> = [];
  try { payroll = await getActivePayrollPatterns(); } catch { /* пусто */ }
  try { rules = await listRules(); } catch { /* пусто */ }

  let created = 0, skipped = 0, payrollCount = 0;
  let totalKop = 0n;

  for (const t of txs) {
    const flowType = t.direction === 'in' ? 'income' : 'expense';
    const cpLower = t.counterparty.toLowerCase();

    let pnlCategory: string | null = null;
    if (flowType === 'expense') {
      if (cpLower.length > 0 && payroll.some((p) => cpLower.includes(p.pattern))) {
        pnlCategory = 'payroll';
      } else {
        const rule = matchRule(rules, t.counterparty, t.description, 'ip');
        pnlCategory = rule?.targetPnlCategory ?? null;
      }
    }

    const occTs = `${t.date}T12:00:00Z`;
    const externalId = `card:${cardCode}:${t.date}:${t.amountKop.toString()}:${cpLower.slice(0, 40)}`;
    const needsReview = flowType === 'expense' && pnlCategory === null;

    const rows = await sql<{ id: string }[]>`
      INSERT INTO transactions (
        flow_type, amount, currency, amount_rub, fx_rate,
        entity_id, direction_id, category_id, source_id,
        occurred_at, description, counterparty, pnl_category,
        external_id, created_by,
        verified, needs_classification, needs_review, needs_owner_review
      ) VALUES (
        ${flowType}, ${t.amountKop}, 'RUB', ${t.amountKop}, NULL,
        ${ENTITY_IDS.ip}, NULL, NULL, ${sourceId},
        ${occTs}, ${t.description}, ${t.counterparty}, ${pnlCategory},
        ${externalId}, ${createdByTgId},
        false, ${needsReview}, ${needsReview}, false
      )
      ON CONFLICT (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
      RETURNING id
    `;

    if (rows[0]) {
      created += 1;
      totalKop += t.amountKop;
      if (pnlCategory === 'payroll') payrollCount += 1;
    } else {
      skipped += 1;
    }
  }

  return { created, skipped, payroll: payrollCount, totalKop };
}
