# Feature: Синхронизация источников (Robokassa / Prodamus / Tochka)

> **Проект:** FinAssist
> **Дата:** 2026-06-10
> **Приоритет:** High
> **Оценка:** 1–2 дня
> **Статус:** НЕ начато (платформенный слой, описан в [mini-app.architector.md](mini-app.architector.md))

---

## 1. Цель

Автоматически наполнять таблицу `transactions` данными из платёжных источников, чтобы и бот, и Mini App, и AI-наставник читали актуальные операции без ручной загрузки выписок.

**Принцип (зафиксирован):** синхронизация — это **платформенный слой**. Источники кладут данные в БД независимо от Mini App и AI-агента; все потребители только читают. AI-агент эти интеграции напрямую НЕ вызывает.

### Источники
| Источник | Транспорт | Что тянем |
|----------|-----------|-----------|
| **Robokassa** | REST API (Operations / выписка по магазину) | входящие платежи ИП |
| **Prodamus** | REST API (заказы/платежи) | входящие платежи по курсу/клубу |
| **Tochka (Точка Банк)** | OAuth 2.0 API | счета, выписки, балансы, операции ООО |

### Критерии приёмки
- [ ] Cron `*/30 * * * *` синхронит все три источника, не блокируя друг друга.
- [ ] Дедупликация по `external_id` — повторный запуск не создаёт дублей.
- [ ] Все суммы в копейках (BIGINT), даты UTC, soft delete не нарушается.
- [ ] Ошибка одного источника логируется + алерт, остальные продолжают работать.
- [ ] Невалидные credentials → источник отключается до исправления (не спамит ошибками).
- [ ] Audit log синхронизаций: timestamp, source, количество операций (без персональных данных и без ключей).
- [ ] Валюта ≠ RUB → пересчёт в рубли через `services/cbr.ts` `convertToRub()`.

---

## 2. Изменения в базе данных

### Новая таблица — audit log синхронизаций
```sql
-- db/migrations/005_sync_audit.sql
CREATE TABLE sync_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code   TEXT NOT NULL,                       -- 'robokassa' | 'prodamus' | 'tochka'
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ok','error','skipped_bad_credentials')),
  fetched_count INTEGER NOT NULL DEFAULT 0,          -- получено из источника
  inserted_count INTEGER NOT NULL DEFAULT 0,         -- реально вставлено (после дедупа)
  error_message TEXT,                                -- БЕЗ ключей/паролей
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_runs_source ON sync_runs(source_code, started_at DESC);
CREATE TRIGGER trg_sync_runs_updated_at BEFORE UPDATE ON sync_runs
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);
```

### Опционально — статус источника (для авто-отключения)
```sql
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sync_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sync_disabled_reason TEXT;
```
> При невалидных credentials выставляем `sync_enabled = false` + причину; ручное включение через `/settings` бота или SQL.

### Существующее (НЕ менять, переиспользовать)
- `transactions.external_id` + UNIQUE INDEX `WHERE external_id IS NOT NULL AND deleted_at IS NULL` — дедупликация уже есть.
- `sources` уже содержит коды `robokassa`, `prodamus`, `tochka` (см. `002_seed.sql`).

---

## 3. Изменения в коде

### Новые файлы
- `src/services/integrations/types.ts` — общий интерфейс:
  ```ts
  export interface RawSourceTransaction {
    externalId: string;            // уникальный id операции в источнике
    occurredAt: string;            // YYYY-MM-DD (UTC)
    amount: bigint;                // копейки в валюте источника
    currency: Currency;            // обычно 'RUB'
    description: string | null;
    rawPayload: Record<string, unknown>;
  }
  export interface SyncResult { fetched: number; inserted: number; }
  export interface SourceSyncer {
    code: 'robokassa' | 'prodamus' | 'tochka';
    sync(sinceDate: string): Promise<SyncResult>;   // since = последняя успешная дата
  }
  ```
- `src/services/integrations/robokassa.ts` — REST-клиент + маппинг в `RawSourceTransaction`.
- `src/services/integrations/prodamus.ts` — REST-клиент (переиспользовать маппинг продукта→направление из `prodamus_product_mapping`, как в `parser/prodamus-csv.ts`).
- `src/services/integrations/tochka.ts` — OAuth 2.0 (хранение/рефреш access_token), выписка по счёту.
- `src/services/integrations/sync.ts` — оркестратор: `syncAllSources()` и `syncSource(code)`; пишет `sync_runs`, дедуп через `external_id`, конвертация валют, retry 3/1s/3s/9s, rate limit (≤3 одновременно — но источников всего 3, так что просто `Promise.allSettled`).
- `src/db/repositories/integrations.ts` — `getLastSuccessfulSync(sourceCode)`, `createSyncRun()`, `finishSyncRun()`, `disableSource()`, вставка транзакций c `ON CONFLICT (external_id) DO NOTHING`.

### Изменяемые файлы
- `src/config.ts` — добавить (Zod, optional, не логировать):
  `ROBOKASSA_MERCHANT_LOGIN`, `ROBOKASSA_PASSWORD`, `PRODAMUS_API_KEY`, `TOCHKA_CLIENT_ID`, `TOCHKA_CLIENT_SECRET`.
- `.env.example` — задокументировать новые переменные.
- `src/index.ts` — cron-задачи (UTC):
  - `*/30 * * * *` → `syncAllSources()`.
  - `0 6 * * *` и `0 15 * * *` → `generateDailyFinancialReport()` (утро/вечер) — уже есть функция в `services/miniApp.ts`, нужно подключить к отправке.
- `src/services/alerts.ts` — алерт владельцу при ошибке синхронизации источника.

---

## 4. Business Logic

- **Инкрементальность:** тянуть операции `since = last_successful_sync(source) − 1 день` (перекрытие на сутки страхует от пропусков; дедуп по `external_id` снимает дубли).
- **Маппинг суммы:** источник отдаёт рубли/копейки → хранить в `amount` (копейки валюты) + `amount_rub` (через `convertToRub()` если валюта ≠ RUB; для RUB `amount_rub = amount`).
- **Категория/направление:** Prodamus — через `prodamus_product_mapping`; Robokassa/Tochka — по описанию/правилам, иначе `needs_classification = true` (опционально пропускать через `services/classifier.ts`).
- **Идемпотентность:** вставка `INSERT ... ON CONFLICT (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL DO NOTHING`.
- **created_by:** системный UUID (служебный пользователь «sync») — добавить в `003_seed_users.sql` или использовать owner.

### Безопасность
- Credentials только в env, никогда не на фронт, **никогда в логи** (strict-check в `utils/logger.ts`).
- В `sync_runs.error_message` и pino — только метаданные (source, counts, timestamp), без ключей и без персональных данных.
- SSL/TLS обязателен для всех внешних запросов.

---

## 5. Edge Cases

| # | Ситуация | Поведение |
|---|----------|-----------|
| 1 | Ошибка сети/5xx одного источника | retry 3×, затем `sync_runs.status='error'` + алерт; остальные источники работают |
| 2 | Невалидные credentials (401/403) | `sources.sync_enabled=false` + причина, `status='skipped_bad_credentials'`, алерт |
| 3 | Дубли операций между запусками | дедуп по `external_id`, `inserted_count` отражает реально новые |
| 4 | Tochka access_token истёк | авто-рефреш по refresh_token; при провале — как edge #2 |
| 5 | Валюта операции ≠ RUB | `convertToRub()`; если курса нет — `amount_rub = NULL`, добор cron'ом `0 10 * * *` (уже есть в index.ts) |
| 6 | Источник вернул пустую выписку | `status='ok'`, `inserted_count=0` — не ошибка |
| 7 | Параллельный запуск cron'а пока идёт прошлый | пропустить новый запуск для занятого источника (флаг/проверка `running` в `sync_runs`) |

---

## 6. Затронутые файлы

**Новые:** `src/services/integrations/{types,robokassa,prodamus,tochka,sync}.ts`, `src/db/repositories/integrations.ts`, `db/migrations/005_sync_audit.sql`.
**Изменяемые:** `src/config.ts`, `.env.example`, `src/index.ts`, `src/services/alerts.ts`, `src/utils/logger.ts` (strict-check ключей).

## 7. План
1. Миграция `005_sync_audit.sql` (+ поля `sources.sync_enabled`).
2. `integrations/types.ts` + репозиторий `integrations.ts` (дедуп/вставка/audit).
3. `prodamus.ts` (проще — есть CSV-аналог), затем `robokassa.ts`, затем `tochka.ts` (OAuth).
4. Оркестратор `sync.ts` + config + env.
5. Cron в `index.ts` + алерты.
6. Субагент **devops-engineer** — env на VPS; **qa-reviewer** — дедуп, утечки ключей, изоляция ошибок.
