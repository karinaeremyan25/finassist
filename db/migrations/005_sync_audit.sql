-- 005_sync_audit.sql
-- Аудит синхронизации платёжных источников (Robokassa, Prodamus, Точка).
-- Добавляет таблицу sync_runs (журнал запусков синхронизации) и поля
-- sources.sync_enabled / sources.sync_disabled_reason для авто-отключения
-- источников с невалидными credentials.
--
-- DOWN-логика (откат):
--   DROP TABLE sync_runs;
--   ALTER TABLE sources DROP COLUMN IF EXISTS sync_disabled_reason;
--   ALTER TABLE sources DROP COLUMN IF EXISTS sync_enabled;
--
-- Соглашения (как в 001_init.sql):
--   - id — UUID DEFAULT gen_random_uuid().
--   - created_at/updated_at + триггер moddatetime.
--   - Текстовые перечисления — TEXT + CHECK (... IN (...)), не enum-типы.
--   - error_message хранит ТОЛЬКО метаданные ошибки, без ключей/паролей.

-- ─────────────────────────────────────────────────────────────
-- Таблица: sync_runs
-- Журнал запусков синхронизации по каждому источнику.
-- Один запуск = одна строка; статус обновляется по ходу (running → ok/error/skipped).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE sync_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code    TEXT NOT NULL,                       -- 'robokassa' | 'prodamus' | 'tochka'
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'ok', 'error', 'skipped_bad_credentials')),
  fetched_count  INTEGER NOT NULL DEFAULT 0,          -- получено из источника
  inserted_count INTEGER NOT NULL DEFAULT 0,          -- реально вставлено (после дедупа)
  error_message  TEXT,                                -- БЕЗ ключей/паролей
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_runs_source ON sync_runs(source_code, started_at DESC);

CREATE TRIGGER trg_sync_runs_updated_at
  BEFORE UPDATE ON sync_runs
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

COMMENT ON TABLE sync_runs IS 'Журнал запусков синхронизации платёжных источников. Один запуск = одна строка.';
COMMENT ON COLUMN sync_runs.source_code IS 'Код источника синхронизации: robokassa | prodamus | tochka. Соответствует sources.code.';
COMMENT ON COLUMN sync_runs.status IS 'running=в процессе, ok=успешно, error=ошибка после retry, skipped_bad_credentials=пропущен из-за невалидных credentials.';
COMMENT ON COLUMN sync_runs.fetched_count IS 'Сколько записей получено из источника.';
COMMENT ON COLUMN sync_runs.inserted_count IS 'Сколько реально вставлено в transactions после дедупликации по external_id.';
COMMENT ON COLUMN sync_runs.error_message IS 'Текст ошибки для диагностики. ТОЛЬКО метаданные, без ключей/паролей/персональных данных.';

-- ─────────────────────────────────────────────────────────────
-- sources: статус синхронизации (для авто-отключения)
-- При невалидных credentials выставляем sync_enabled=false + причину;
-- ручное включение через /settings бота или SQL.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sync_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sync_disabled_reason TEXT;

COMMENT ON COLUMN sources.sync_enabled IS 'Включена ли авто-синхронизация источника. false при невалидных credentials; ручное включение через /settings или SQL.';
COMMENT ON COLUMN sources.sync_disabled_reason IS 'Причина отключения синхронизации (например, "401 invalid credentials"). NULL когда sync_enabled=true.';
