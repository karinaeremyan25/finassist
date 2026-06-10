---
description: Правила для работы с PostgreSQL и миграциями FinAssist
globs: ["src/db/**", "db/**"]
---
- Все суммы — BIGINT в копейках. `float`, `decimal`, `parseFloat` для денег — запрещены
- Soft delete через `deleted_at TIMESTAMPTZ`. Физическое удаление транзакций запрещено
- Только параметризованные запросы: `sql\`SELECT ... WHERE id = ${id}\`` — никакой конкатенации строк
- Все таблицы: `created_at`, `updated_at` с триггером `moddatetime`
- UUID через `gen_random_uuid()`, не serial/sequence
- TEXT + CHECK-ограничения вместо enum-типов PostgreSQL
- FK с явным `ON DELETE CASCADE` или `RESTRICT`
- RLS отключена — изоляция в Node.js-слое, не в БД
- Индексы обязательны: `telegram_id`, `entity_id`, `direction_id`, `created_at`, `deleted_at`
- Дедупликация Продамуса: UNIQUE INDEX `WHERE external_id IS NOT NULL AND deleted_at IS NULL`
