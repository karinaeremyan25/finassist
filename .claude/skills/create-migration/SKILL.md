---
name: create-migration
description: "Создаёт SQL-миграцию для FinAssist. Используй когда нужно изменить схему БД."
---
Создай SQL-миграцию для FinAssist в `db/migrations/`.

1. **Определи номер** — посмотри существующие миграции, возьми следующий номер (NNN)

2. **Имя файла:** `NNN_краткое_описание.sql`

3. **Шаблон содержимого:**
```sql
-- Migration: NNN_описание
-- Purpose: что делает и почему
-- Rollback: как откатить (DROP TABLE / ALTER TABLE DROP COLUMN / etc.)

-- === UP ===

CREATE TABLE IF NOT EXISTS имя_таблицы (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  -- поля...
  created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Trigger для updated_at
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON имя_таблицы
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- Индексы
CREATE INDEX idx_имя_поле ON имя_таблицы(поле);

-- Комментарии
COMMENT ON TABLE имя_таблицы IS 'Описание таблицы';
COMMENT ON COLUMN имя_таблицы.поле IS 'Описание поля';
```

4. **Обязательные проверки перед созданием:**
   - Денежные поля → BIGINT (копейки), не DECIMAL/NUMERIC
   - Нужен soft delete → добавить `deleted_at TIMESTAMPTZ`
   - Нужна дедупликация → UNIQUE INDEX с WHERE-условием
   - FK → указать ON DELETE (CASCADE или RESTRICT)
   - Не добавлять RLS (по архитектуре проекта)

5. **После создания файла** — делегируй субагенту `database-architect` для проверки корректности.
