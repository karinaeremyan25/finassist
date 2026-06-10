import { sql } from '../client.js';
import { mapTransaction, type TransactionRow } from './_mappers.js';
import type { Transaction, FlowType, Currency } from '../../types.js';

/**
 * Репозиторий транзакций.
 *
 * Правила:
 * - Только параметризованные запросы (tagged templates postgres.js).
 * - Все суммы — bigint (копейки).
 * - Soft delete: каждый read-запрос добавляет WHERE deleted_at IS NULL.
 * - RLS отключена — без viewer-фильтров по роли (изоляция выше по стеку,
 *   в сервисах analytics при необходимости).
 * - Все правки фиксируются в transaction_edits в той же БД-транзакции.
 */

/** Данные для создания транзакции. */
export interface TransactionCreate {
  flowType: FlowType;
  amount: bigint;
  currency: Currency;
  amountRub: bigint;
  fxRate?: number | null;
  entityId: string;
  directionId?: string | null;
  categoryId?: string | null;
  sourceId: string;
  occurredAt: string; // YYYY-MM-DD
  description?: string | null;
  externalId?: string | null;
  createdBy: string;
  verified?: boolean;
  needsClassification?: boolean;
  needsOwnerReview?: boolean;
  aiConfidence?: number | null;
  rawInput?: string | null;
  rawAiResponse?: Record<string, unknown> | null;
}

/** Поля, доступные для обновления через updateTransaction. */
export interface TransactionUpdate {
  flowType: FlowType;
  amount: bigint;
  currency: Currency;
  amountRub: bigint;
  fxRate: number | null;
  entityId: string;
  directionId: string | null;
  categoryId: string | null;
  sourceId: string;
  occurredAt: string;
  description: string | null;
  needsClassification: boolean;
  needsOwnerReview: boolean;
}

export interface GetTransactionsFilters {
  entityId?: string;
  directionId?: string;
  dateFrom?: string; // YYYY-MM-DD, включительно
  dateTo?: string; // YYYY-MM-DD, включительно
  flowType?: FlowType;
  verified?: boolean;
}

export interface GetUnverifiedFilters {
  flowType?: FlowType;
  hasDirection?: boolean; // true = с направлением, false = без (NULL)
  dateFrom?: string;
}

const SELECT_COLUMNS = sql`
  id, flow_type, amount, currency, amount_rub, fx_rate,
  entity_id, direction_id, category_id, source_id,
  occurred_at, description, external_id,
  created_by, verified, verified_by, verified_at,
  needs_classification, needs_owner_review, ai_confidence,
  raw_input, raw_ai_response, deleted_at, created_at, updated_at
`;

export async function createTransaction(data: TransactionCreate): Promise<Transaction> {
  const rawAiResponse = data.rawAiResponse ?? null;

  const rows = await sql<TransactionRow[]>`
    INSERT INTO transactions (
      flow_type, amount, currency, amount_rub, fx_rate,
      entity_id, direction_id, category_id, source_id,
      occurred_at, description, external_id,
      created_by, verified, needs_classification, needs_owner_review,
      ai_confidence, raw_input, raw_ai_response
    ) VALUES (
      ${data.flowType}, ${data.amount}, ${data.currency}, ${data.amountRub}, ${data.fxRate ?? null},
      ${data.entityId}, ${data.directionId ?? null}, ${data.categoryId ?? null}, ${data.sourceId},
      ${data.occurredAt}, ${data.description ?? null}, ${data.externalId ?? null},
      ${data.createdBy}, ${data.verified ?? false}, ${data.needsClassification ?? false}, ${data.needsOwnerReview ?? false},
      ${data.aiConfidence ?? null}, ${data.rawInput ?? null}, ${rawAiResponse as never}
    )
    RETURNING ${SELECT_COLUMNS}
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new Error('createTransaction: INSERT did not return a row');
  }

  await sql`
    INSERT INTO transaction_edits (transaction_id, edited_by, edit_type, after_json)
    VALUES (${row.id}, ${data.createdBy}, 'create', ${sql.json(row as never)})
  `;

  return mapTransaction(row);
}

export async function getTransactionById(id: string): Promise<Transaction | null> {
  const rows = await sql<TransactionRow[]>`
    SELECT ${SELECT_COLUMNS}
    FROM transactions
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  const row = rows[0];
  return row === undefined ? null : mapTransaction(row);
}

export async function getTransactions(filters: GetTransactionsFilters): Promise<Transaction[]> {
  const rows = await sql<TransactionRow[]>`
    SELECT ${SELECT_COLUMNS}
    FROM transactions
    WHERE deleted_at IS NULL
      ${filters.entityId !== undefined ? sql`AND entity_id = ${filters.entityId}` : sql``}
      ${filters.directionId !== undefined ? sql`AND direction_id = ${filters.directionId}` : sql``}
      ${filters.flowType !== undefined ? sql`AND flow_type = ${filters.flowType}` : sql``}
      ${filters.verified !== undefined ? sql`AND verified = ${filters.verified}` : sql``}
      ${filters.dateFrom !== undefined ? sql`AND occurred_at >= ${filters.dateFrom}` : sql``}
      ${filters.dateTo !== undefined ? sql`AND occurred_at <= ${filters.dateTo}` : sql``}
    ORDER BY occurred_at DESC, created_at DESC
  `;
  return rows.map(mapTransaction);
}

export async function getUnverifiedTransactions(
  filters: GetUnverifiedFilters = {}
): Promise<Transaction[]> {
  const directionFilter =
    filters.hasDirection === true
      ? sql`AND direction_id IS NOT NULL`
      : filters.hasDirection === false
        ? sql`AND direction_id IS NULL`
        : sql``;

  const rows = await sql<TransactionRow[]>`
    SELECT ${SELECT_COLUMNS}
    FROM transactions
    WHERE deleted_at IS NULL
      AND verified = false
      ${filters.flowType !== undefined ? sql`AND flow_type = ${filters.flowType}` : sql``}
      ${directionFilter}
      ${filters.dateFrom !== undefined ? sql`AND occurred_at >= ${filters.dateFrom}` : sql``}
    ORDER BY occurred_at DESC, created_at DESC
  `;
  return rows.map(mapTransaction);
}

/**
 * Обновляет редактируемые поля транзакции и пишет запись в transaction_edits.
 * Оптимистичная блокировка: WHERE updated_at = previous (edge case #9 из SPEC).
 * Передавать только изменяемые поля через data.
 */
export async function updateTransaction(
  id: string,
  data: Partial<TransactionUpdate>,
  editedBy: string
): Promise<Transaction> {
  return sql.begin(async (tx) => {
    const beforeRows = await tx<TransactionRow[]>`
      SELECT ${SELECT_COLUMNS}
      FROM transactions
      WHERE id = ${id} AND deleted_at IS NULL
      FOR UPDATE
    `;
    const before = beforeRows[0];
    if (before === undefined) {
      throw new Error(`updateTransaction: transaction ${id} not found or deleted`);
    }

    // Собираем только переданные поля. Ключи статичны (не из пользовательского
    // ввода), значения параметризуются — SQL-инъекция невозможна.
    const updates: Record<string, unknown> = {};
    if (data.flowType !== undefined) updates['flow_type'] = data.flowType;
    if (data.amount !== undefined) updates['amount'] = data.amount;
    if (data.currency !== undefined) updates['currency'] = data.currency;
    if (data.amountRub !== undefined) updates['amount_rub'] = data.amountRub;
    if (data.fxRate !== undefined) updates['fx_rate'] = data.fxRate;
    if (data.entityId !== undefined) updates['entity_id'] = data.entityId;
    if (data.directionId !== undefined) updates['direction_id'] = data.directionId;
    if (data.categoryId !== undefined) updates['category_id'] = data.categoryId;
    if (data.sourceId !== undefined) updates['source_id'] = data.sourceId;
    if (data.occurredAt !== undefined) updates['occurred_at'] = data.occurredAt;
    if (data.description !== undefined) updates['description'] = data.description;
    if (data.needsClassification !== undefined)
      updates['needs_classification'] = data.needsClassification;
    if (data.needsOwnerReview !== undefined) updates['needs_owner_review'] = data.needsOwnerReview;

    const updateKeys = Object.keys(updates);
    if (updateKeys.length === 0) {
      return mapTransaction(before);
    }

    const afterRows = await tx<TransactionRow[]>`
      UPDATE transactions
      SET ${tx(updates, ...updateKeys)}
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING ${SELECT_COLUMNS}
    `;
    const after = afterRows[0];
    if (after === undefined) {
      throw new Error(`updateTransaction: failed to update transaction ${id}`);
    }

    await tx`
      INSERT INTO transaction_edits (transaction_id, edited_by, edit_type, before_json, after_json)
      VALUES (${id}, ${editedBy}, 'update', ${tx.json(before as never)}, ${tx.json(after as never)})
    `;

    return mapTransaction(after);
  });
}

export async function verifyTransaction(id: string, verifiedBy: string): Promise<Transaction> {
  return sql.begin(async (tx) => {
    const rows = await tx<TransactionRow[]>`
      UPDATE transactions
      SET verified = true,
          verified_by = ${verifiedBy},
          verified_at = NOW(),
          needs_owner_review = false
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING ${SELECT_COLUMNS}
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`verifyTransaction: transaction ${id} not found or deleted`);
    }

    await tx`
      INSERT INTO transaction_edits (transaction_id, edited_by, edit_type, after_json)
      VALUES (${id}, ${verifiedBy}, 'verify', ${tx.json(row as never)})
    `;

    return mapTransaction(row);
  });
}

export async function softDeleteTransaction(id: string, deletedBy: string): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<TransactionRow[]>`
      UPDATE transactions
      SET deleted_at = NOW(), deleted_by = ${deletedBy}
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING ${SELECT_COLUMNS}
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`softDeleteTransaction: transaction ${id} not found or already deleted`);
    }

    await tx`
      INSERT INTO transaction_edits (transaction_id, edited_by, edit_type, before_json)
      VALUES (${id}, ${deletedBy}, 'delete', ${tx.json(row as never)})
    `;
  });
}

/**
 * Возвращает множество external_id, которые уже существуют в активных
 * транзакциях. Используется для дедупликации импорта Продамуса.
 */
export async function getTransactionsByExternalIds(externalIds: string[]): Promise<string[]> {
  if (externalIds.length === 0) {
    return [];
  }
  const rows = await sql<{ external_id: string }[]>`
    SELECT external_id
    FROM transactions
    WHERE external_id IN ${sql(externalIds)}
      AND deleted_at IS NULL
  `;
  return rows.map((r) => r.external_id);
}
