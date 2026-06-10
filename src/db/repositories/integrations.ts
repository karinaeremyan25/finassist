import { z } from 'zod';
import { sql } from '../client.js';
import type { SourceCode, RawSourceTransaction } from '../../services/integrations/types.js';
import { convertToRub } from '../../services/cbr.js';

/**
 * Репозиторий синхронизации платёжных источников.
 *
 * Отвечает за:
 * - Аудит запусков синхронизации (sync_runs).
 * - Авто-отключение источников с невалидными credentials (sources.sync_enabled).
 * - Дедуп-вставку транзакций с INSERT ... ON CONFLICT DO NOTHING.
 *
 * Все запросы — параметризованные (tagged template postgres.js).
 * Суммы — BIGINT копейки. Секреты НИКОГДА не попадают в error_message или логи.
 */

// ─────────────────────────────────────────────────────────────
// Zod-схемы валидации входных данных
// ─────────────────────────────────────────────────────────────

const SourceCodeSchema = z.enum(['robokassa', 'prodamus', 'tochka']);

const FinishSyncSchema = z.object({
  status: z.enum(['ok', 'error', 'skipped_bad_credentials']),
  fetched: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  errorMessage: z.string().max(1000).optional(),
});

export type FinishSyncInput = z.input<typeof FinishSyncSchema>;

// ─────────────────────────────────────────────────────────────
// Строка sync_runs из БД
// ─────────────────────────────────────────────────────────────

interface SyncRunRow {
  id: string;
  source_code: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  fetched_count: number;
  inserted_count: number;
  error_message: string | null;
}

export interface SyncRun {
  id: string;
  sourceCode: SourceCode;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'ok' | 'error' | 'skipped_bad_credentials';
  fetchedCount: number;
  insertedCount: number;
  errorMessage: string | null;
}

function mapSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    sourceCode: row.source_code as SourceCode,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as SyncRun['status'],
    fetchedCount: row.fetched_count,
    insertedCount: row.inserted_count,
    errorMessage: row.error_message,
  };
}

// ─────────────────────────────────────────────────────────────
// sync_runs
// ─────────────────────────────────────────────────────────────

/**
 * Возвращает последний успешный запуск синхронизации для источника.
 * Используется для расчёта since-даты (last_successful - 1 день).
 */
export async function getLastSuccessfulSync(sourceCode: SourceCode): Promise<SyncRun | null> {
  SourceCodeSchema.parse(sourceCode);

  const rows = await sql<SyncRunRow[]>`
    SELECT id, source_code, started_at, finished_at, status,
           fetched_count, inserted_count, error_message
    FROM sync_runs
    WHERE source_code = ${sourceCode}
      AND status = 'ok'
    ORDER BY started_at DESC
    LIMIT 1
  `;

  const row = rows[0];
  return row === undefined ? null : mapSyncRun(row);
}

/**
 * Проверяет, есть ли уже запущенная (running) синхронизация для источника.
 * Используется для защиты от параллельного запуска.
 */
export async function isSourceSyncRunning(sourceCode: SourceCode): Promise<boolean> {
  SourceCodeSchema.parse(sourceCode);

  const rows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*) AS cnt
    FROM sync_runs
    WHERE source_code = ${sourceCode}
      AND status = 'running'
      AND started_at >= NOW() - INTERVAL '2 hours'
  `;
  return Number(rows[0]?.cnt ?? 0) > 0;
}

/**
 * Создаёт запись о начале синхронизации (status='running').
 * Возвращает UUID созданной записи.
 */
export async function createSyncRun(sourceCode: SourceCode): Promise<string> {
  SourceCodeSchema.parse(sourceCode);

  const rows = await sql<{ id: string }[]>`
    INSERT INTO sync_runs (source_code, status, fetched_count, inserted_count)
    VALUES (${sourceCode}, 'running', 0, 0)
    RETURNING id
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`createSyncRun: INSERT did not return id for source ${sourceCode}`);
  }
  return row.id;
}

/**
 * Завершает запись синхронизации — выставляет финальный статус и счётчики.
 * errorMessage должен содержать ТОЛЬКО метаданные, без ключей/паролей.
 */
export async function finishSyncRun(
  syncRunId: string,
  input: FinishSyncInput
): Promise<void> {
  const data = FinishSyncSchema.parse(input);

  await sql`
    UPDATE sync_runs
    SET status         = ${data.status},
        fetched_count  = ${data.fetched},
        inserted_count = ${data.inserted},
        finished_at    = NOW(),
        error_message  = ${data.errorMessage ?? null}
    WHERE id = ${syncRunId}
  `;
}

// ─────────────────────────────────────────────────────────────
// sources — авто-отключение
// ─────────────────────────────────────────────────────────────

/**
 * Проверяет, включена ли синхронизация для источника.
 * Возвращает false если credentials невалидны (sync_enabled=false).
 */
export async function isSourceSyncEnabled(sourceCode: SourceCode): Promise<boolean> {
  SourceCodeSchema.parse(sourceCode);

  const rows = await sql<{ sync_enabled: boolean }[]>`
    SELECT sync_enabled
    FROM sources
    WHERE code = ${sourceCode}
    LIMIT 1
  `;

  const row = rows[0];
  // Источник не найден — считаем отключённым.
  return row?.sync_enabled ?? false;
}

/**
 * Отключает синхронизацию источника до ручного исправления.
 * reason должен содержать ТОЛЬКО метаданные (HTTP статус, без ключей).
 */
export async function disableSource(sourceCode: SourceCode, reason: string): Promise<void> {
  SourceCodeSchema.parse(sourceCode);

  await sql`
    UPDATE sources
    SET sync_enabled         = false,
        sync_disabled_reason = ${reason}
    WHERE code = ${sourceCode}
  `;
}

/**
 * Включает синхронизацию источника (ручное восстановление через /settings или SQL).
 */
export async function enableSource(sourceCode: SourceCode): Promise<void> {
  SourceCodeSchema.parse(sourceCode);

  await sql`
    UPDATE sources
    SET sync_enabled         = true,
        sync_disabled_reason = NULL
    WHERE code = ${sourceCode}
  `;
}

// ─────────────────────────────────────────────────────────────
// Вставка транзакций (дедуп-пачка)
// ─────────────────────────────────────────────────────────────

/**
 * Параметры для вставки синхронизированной транзакции.
 */
export interface InsertSyncTransactionsInput {
  sourceCode: SourceCode;
  transactions: RawSourceTransaction[];
  /** UUID пользователя-создателя (служебный, owner или системный). */
  createdBy: string;
  /** UUID entity — юрлицо, к которому относится источник. */
  entityId: string;
  /** UUID direction — направление (если определено из маппинга). Иначе null. */
  directionId: string | null;
  /** UUID category — категория (если определена). Иначе null. */
  categoryId: string | null;
  /** flow_type транзакций из этого источника (обычно 'income'). */
  flowType: 'income' | 'expense';
}

const InsertSyncInputSchema = z.object({
  sourceCode: SourceCodeSchema,
  transactions: z.array(z.object({
    externalId: z.string().min(1),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: z.bigint().positive(),
    currency: z.enum(['RUB', 'USD', 'EUR', 'KZT', 'OTHER']),
    description: z.string().nullable(),
    rawPayload: z.record(z.unknown()),
  })),
  createdBy: z.string().uuid(),
  entityId: z.string().uuid(),
  directionId: z.string().uuid().nullable(),
  categoryId: z.string().uuid().nullable(),
  flowType: z.enum(['income', 'expense']),
});

/**
 * Резолвит UUID источника по его коду из таблицы sources.
 */
export async function getSourceIdByCode(sourceCode: SourceCode): Promise<string | null> {
  SourceCodeSchema.parse(sourceCode);

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources WHERE code = ${sourceCode} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Пакетная дедуп-вставка транзакций с конвертацией валют.
 *
 * INSERT ... ON CONFLICT (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
 * DO NOTHING — идемпотентно, повторный запуск не создаёт дублей.
 *
 * Возвращает число РЕАЛЬНО вставленных записей (после дедупликации).
 */
export async function insertSyncTransactions(
  input: InsertSyncTransactionsInput
): Promise<number> {
  const data = InsertSyncInputSchema.parse(input);

  if (data.transactions.length === 0) return 0;

  const sourceId = await getSourceIdByCode(data.sourceCode);
  if (sourceId === null) {
    throw new Error(`insertSyncTransactions: source not found for code=${data.sourceCode}`);
  }

  let inserted = 0;

  // Вставляем по одной для корректного подсчёта inserted (ON CONFLICT DO NOTHING
  // не возвращает строки при конфликте). Для небольших батчей (до ~1000 за раз)
  // это приемлемо. При необходимости можно переключить на CTE с unnest.
  for (const tx of data.transactions) {
    // Конвертация валюты в рубли через cbr.ts
    const { amountRub, fxRate } = await convertToRub(tx.amount, tx.currency, tx.occurredAt);

    const rows = await sql<{ id: string }[]>`
      INSERT INTO transactions (
        flow_type, amount, currency, amount_rub, fx_rate,
        entity_id, direction_id, category_id, source_id,
        occurred_at, description, external_id,
        created_by, verified, needs_classification, needs_owner_review,
        raw_ai_response
      ) VALUES (
        ${data.flowType},
        ${tx.amount},
        ${tx.currency},
        ${amountRub},
        ${fxRate ?? null},
        ${data.entityId},
        ${data.directionId ?? null},
        ${data.categoryId ?? null},
        ${sourceId},
        ${tx.occurredAt},
        ${tx.description ?? null},
        ${tx.externalId},
        ${data.createdBy},
        false,
        ${data.categoryId === null},
        false,
        ${sql.json(tx.rawPayload as never)}
      )
      ON CONFLICT (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
      RETURNING id
    `;

    if (rows.length > 0 && rows[0] !== undefined) {
      inserted++;
    }
  }

  return inserted;
}

// ─────────────────────────────────────────────────────────────
// prodamus_product_mapping — для Prodamus REST syncer
// ─────────────────────────────────────────────────────────────

export interface ProductMappingRow {
  productPattern: string;
  matchType: 'contains' | 'regex' | 'exact';
  directionId: string;
  entityId: string;
  categoryId: string | null;
}

/**
 * Загружает активные правила маппинга продукт → направление/юрлицо.
 * Используется в Prodamus-синхронизаторе для определения direction/entity.
 */
export async function getActiveProdamusMappings(): Promise<ProductMappingRow[]> {
  const rows = await sql<{
    product_pattern: string;
    match_type: string;
    direction_id: string;
    entity_id: string;
    category_id: string | null;
  }[]>`
    SELECT product_pattern, match_type, direction_id, entity_id, category_id
    FROM prodamus_product_mapping
    WHERE is_active = true
    ORDER BY LENGTH(product_pattern) DESC
  `;

  return rows.map((r) => ({
    productPattern: r.product_pattern,
    matchType: r.match_type as ProductMappingRow['matchType'],
    directionId: r.direction_id,
    entityId: r.entity_id,
    categoryId: r.category_id,
  }));
}
