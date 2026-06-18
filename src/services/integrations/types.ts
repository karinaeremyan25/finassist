import type { Currency } from '../../types.js';

/**
 * Общие типы платёжного платформенного слоя синхронизации.
 *
 * Принцип: источники кладут данные в БД независимо от Mini App и AI-агента;
 * все потребители только читают. AI-агент эти интеграции напрямую НЕ вызывает.
 */

/** Код источника — строго типизированное перечисление. */
export type SourceCode = 'robokassa' | 'prodamus' | 'tochka' | 'lava';

/**
 * Сырая транзакция из источника до записи в БД.
 * amount — в копейках/минимальных единицах валюты источника (не в рублях).
 */
export interface RawSourceTransaction {
  /** Уникальный идентификатор операции в источнике (для дедупликации по external_id). */
  externalId: string;
  /** Дата операции UTC, формат YYYY-MM-DD. */
  occurredAt: string;
  /** Сумма в копейках валюты источника (BIGINT, никогда не float). */
  amount: bigint;
  /** Валюта источника. Для RUB: amount = копейки, amountRub = amount. */
  currency: Currency;
  /** Описание операции (не логируется). */
  description: string | null;
  /**
   * Оригинальный ответ источника для отладки (хранится в raw_ai_response / raw_input).
   * НЕ содержит ключей/паролей/персональных данных покупателя.
   */
  rawPayload: Record<string, unknown>;
  /**
   * Принудительно задать needs_classification.
   * Если не задано — вычисляется как categoryId === null в insertSyncTransactions.
   * Используется Точкой: other_expense с categoryId заданным, но нужна классификация.
   */
  needsClassification?: boolean;
}

/** Результат одного прогона синхронизации. */
export interface SyncResult {
  /** Сколько записей получено из источника (до дедупликации). */
  fetched: number;
  /** Сколько реально вставлено в transactions (после дедупликации по external_id). */
  inserted: number;
}

/**
 * Интерфейс синхронизатора источника.
 * Каждый конкретный источник (Robokassa, Prodamus, Tochka) реализует его.
 */
export interface SourceSyncer {
  /** Код источника — совпадает с sources.code в БД. */
  readonly code: SourceCode;
  /**
   * Синхронизирует транзакции начиная с даты sinceDate.
   * @param sinceDate YYYY-MM-DD — нижняя граница (последняя успешная – 1 день).
   * @returns количество полученных и вставленных записей.
   */
  sync(sinceDate: string): Promise<SyncResult>;
}
