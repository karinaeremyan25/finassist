import type { Transaction, AppUser, BotSession } from '../../types.js';

/**
 * Преобразователи snake_case строк PostgreSQL в camelCase доменные типы.
 *
 * postgres.js возвращает имена колонок как есть (snake_case), а денежные
 * BIGINT — как JS `bigint` (см. конфиг клиента db/client.ts).
 */

/** Сырая строка таблицы transactions (snake_case как в БД). */
export interface TransactionRow {
  id: string;
  flow_type: string;
  amount: bigint;
  currency: string;
  amount_rub: bigint;
  fx_rate: string | null;
  entity_id: string;
  direction_id: string | null;
  category_id: string | null;
  source_id: string;
  occurred_at: string | Date;
  description: string | null;
  external_id: string | null;
  created_by: string;
  verified: boolean;
  verified_by: string | null;
  verified_at: Date | null;
  needs_classification: boolean;
  needs_owner_review: boolean;
  ai_confidence: string | null;
  raw_input: string | null;
  raw_ai_response: Record<string, unknown> | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** occurred_at хранится как DATE; нормализуем к строке YYYY-MM-DD. */
function toDateString(value: string | Date): string {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.slice(0, 10);
  }
  // DATE из postgres.js приходит строкой 'YYYY-MM-DD'
  return value.length > 10 ? value.slice(0, 10) : value;
}

export function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    flowType: row.flow_type as Transaction['flowType'],
    amount: row.amount,
    currency: row.currency as Transaction['currency'],
    amountRub: row.amount_rub,
    fxRate: row.fx_rate === null ? null : Number(row.fx_rate),
    entityId: row.entity_id,
    directionId: row.direction_id,
    categoryId: row.category_id,
    sourceId: row.source_id,
    occurredAt: toDateString(row.occurred_at),
    description: row.description,
    externalId: row.external_id,
    createdBy: row.created_by,
    verified: row.verified,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    needsClassification: row.needs_classification,
    needsOwnerReview: row.needs_owner_review,
    aiConfidence: row.ai_confidence === null ? null : Number(row.ai_confidence),
    rawInput: row.raw_input,
    rawAiResponse: row.raw_ai_response,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Сырая строка таблицы app_users. */
export interface AppUserRow {
  id: string;
  telegram_id: bigint;
  full_name: string;
  role: string;
  is_active: boolean;
}

export function mapAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    telegramId: row.telegram_id,
    fullName: row.full_name,
    role: row.role as AppUser['role'],
    isActive: row.is_active,
  };
}

/** Сырая строка таблицы bot_sessions. */
export interface BotSessionRow {
  telegram_id: bigint;
  state: string;
  context: Record<string, unknown>;
  expires_at: Date;
}

export function mapBotSession(row: BotSessionRow): BotSession {
  return {
    telegramId: row.telegram_id,
    state: row.state,
    context: row.context,
    expiresAt: row.expires_at,
  };
}
