# Feature: Синхронизация источников (Tochka pull + Robokassa/Prodamus webhook)

> **Проект:** FinAssist
> **Дата:** 2026-06-10
> **Приоритет:** High
> **Оценка:** 1–2 дня
> **Статус:** Реализовано

---

## 1. Цель

Автоматически наполнять таблицу `transactions` данными из платёжных источников, чтобы и бот, и Mini App, и AI-наставник читали актуальные операции без ручной загрузки выписок.

**Принцип (зафиксирован):** синхронизация — это **платформенный слой**. Источники кладут данные в БД независимо от Mini App и AI-агента; все потребители только читают. AI-агент эти интеграции напрямую НЕ вызывает.

### Источники и транспорт

| Источник | Транспорт | Что получаем |
|----------|-----------|--------------|
| **Tochka (Точка Банк)** | **Pull** — cron OAuth 2.0 Open Banking statements | Выписки и балансы ООО |
| **Robokassa** | **Push** — webhook (ResultURL) + проверка MD5 подписи | Входящие платежи ИП |
| **Prodamus** | **Push** — webhook + HMAC-SHA256 (заголовок Sign) | Входящие платежи по курсу/клубу |

**Ключевой вывод:** у Robokassa и Prodamus нет API списка операций за период. Они присылают push-уведомления (webhook) на наш URL. Tochka — единственный pull-источник.

### Webhook-URL'ы (настроить в ЛК платёжных систем)

| Источник | URL | Где настроить |
|----------|-----|---------------|
| Robokassa | `https://<домен>/api/webhooks/robokassa` | ЛК → Технические настройки → ResultURL |
| Prodamus | `https://<домен>/api/webhooks/prodamus` | ЛК → Настройки → Уведомления → URL вебхука |

### Критерии приёмки

- [x] Cron `*/30 * * * *` синкает только Tochka (pull), не блокируя другие задачи.
- [x] Robokassa/Prodamus принимают webhook, проверяют подпись, вставляют транзакцию.
- [x] Дедупликация по `external_id` — повторный запуск не создаёт дублей.
- [x] Все суммы в копейках (BIGINT), даты UTC, soft delete не нарушается.
- [x] Ошибка Tochka-синка логируется + алерт, бот продолжает работать.
- [x] Невалидные credentials Tochka → источник отключается до исправления.
- [x] Robokassa: неверная подпись → HTTP 400 `bad sign`, транзакция не создаётся.
- [x] Prodamus: неверная подпись → HTTP 400, транзакция не создаётся.
- [x] Audit log синхронизаций Tochka: timestamp, source, количество операций (без ключей/сумм/email).
- [x] Валюта ≠ RUB → пересчёт через `services/cbr.ts` `convertToRub()`.

---

## 2. База данных

### Таблица audit log синхронизаций (только Tochka fill)
```sql
-- db/migrations/005_sync_audit.sql
CREATE TABLE sync_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code   TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ok','error','skipped_bad_credentials')),
  fetched_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Поля в sources для авто-отключения (Tochka)
```sql
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sync_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sync_disabled_reason TEXT;
```

---

## 3. Изменения в коде

### Файлы сервисов интеграций

**`src/services/integrations/types.ts`** — общие типы (без изменений):
- `RawSourceTransaction`, `SyncResult`, `SourceSyncer` интерфейс.

**`src/services/integrations/tochka.ts`** — переписан на реальный Open Banking API:
- OAuth client_credentials → `POST /connect/token` (scope: `accounts balances customers statements sbp payments`).
- `GET /accounts` → список accountId.
- Для каждого счёта: `POST /statements` (initiate) → поллинг `GET /accounts/{id}/statements/{sid}` пока `status=Ready`.
- Маппинг Transaction[] → RawSourceTransaction[] (Credit=income, Debit=expense).
- In-memory token cache (24ч, буфер 60с), авто-рефреш при 401.
- TODO: если client_credentials не даёт выписок — нужен authorization_code + consent flow.

**`src/services/integrations/robokassa.ts`** — переделан в webhook-помощник:
- Удалён HTTP-пуллинг (GetOperationList).
- `verifyRobokassaSignature(outSum, invId, signatureValue, password, rawPayload)` — MD5.
- `handleRobokassaWebhook(rawFields)` — проверка подписи, вставка транзакции, ответ `OK${InvId}`.

**`src/services/integrations/prodamus.ts`** — переделан в webhook-помощник:
- Удалён REST-пуллинг (/orders API).
- `computeProdamusSignature(fields, secretKey)` — рекурсивная сортировка ключей, JSON.stringify с экранированием `/`, HMAC-SHA256.
- `handleProdamusWebhook(rawFields, signHeader)` — проверка подписи из заголовка `Sign`, вставка.
- Маппинг продукта через `prodamus_product_mapping` (как CSV-импорт).

**`src/services/integrations/sync.ts`** — оркестратор только для Tochka:
- `ALL_SOURCES` убрано, вместо него `PULL_SOURCES = ['tochka']`.
- `syncSource('tochka')` + `syncAllSources()` — без изменения сигнатур.

### Файлы HTTP-инфраструктуры

**`src/server/http.ts`** — расширен обратносовместимо:
- `ApiRequest.rawBody?: string` — сырая строка тела (JSON и urlencoded).
- `ApiResponse.rawBody?: string` + `ApiResponse.contentType?: string` — raw text ответы.
- `readBody()` теперь парсит `application/x-www-form-urlencoded` → реконструированный объект.
- `parseNestedFormFields(params)` — утилита реконструкции вложенных ключей `products[0][name]` → `{products:[{name:...}]}`.
- Существующий JSON-путь, static-serving, тело-лимит 256KB — не изменены.

**`src/server/routes/webhooks.ts`** — новый файл:
- `robokassaWebhookHandler` → `POST /api/webhooks/robokassa`
- `prodamusWebhookHandler` → `POST /api/webhooks/prodamus`
- Логируют только: источник, статус подписи (ok/fail), latency_ms. Суммы/email/тела не логируются.

**`src/server/index.ts`** — добавлена регистрация webhook-роутов.

### Конфигурация

**`src/config.ts`** — добавлено поле `PRODAMUS_SECRET_KEY` (optional).

**`.env.example`** — обновлено:
- Добавлено `PRODAMUS_SECRET_KEY` с пояснением.
- Уточнено что `ROBOKASSA_PASSWORD` = Пароль #2 (для подписи webhook, не для API).
- Добавлены URL-адреса для настройки webhook в ЛК.

---

## 4. Алгоритмы проверки подписей

### Robokassa (MD5)

```
base = "${OutSum}:${InvId}:${ROBOKASSA_PASSWORD}"
// Если есть Shp_* параметры — добавить в алфавитном порядке:
for each Shp_key (sorted ASC):
  base += ":${Shp_key}=${Shp_value}"
expected = MD5(base).hex
ok = (expected.toLowerCase() === SignatureValue.toLowerCase())
```

Успешный ответ: HTTP 200, `text/plain`, тело = `OK${InvId}`.
Неверная подпись: HTTP 400, `text/plain`, тело = `bad sign`.

### Prodamus (HMAC-SHA256, PHP-совместимый)

```
1. Взять все POST-поля (включая вложенные products[i][...] — уже реконструированы).
2. Рекурсивно отсортировать по ключам (аналог PHP ksort).
3. Все листовые значения → строки.
4. JSON.stringify(sortedObject)
5. Экранировать прямые слэши: "/" → "\/" (как PHP json_encode)
6. HMAC-SHA256(jsonStr, PRODAMUS_SECRET_KEY).hex
7. Сравнить с заголовком Sign (case-insensitive)
```

Успешный ответ: HTTP 200, `text/plain`, тело = `success`.
Неверная подпись: HTTP 400, `text/plain`, тело = `bad sign`.

---

## 5. Business Logic

- **Tochka — инкрементальность:** sinceDate = `last_successful_sync - 1 день` (перекрытие страхует от пропусков). Первый запуск: 90 дней назад.
- **Dедупликация:** `INSERT ... ON CONFLICT (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL DO NOTHING`.
- **Маппинг суммы:** источник → копейки через `utils/money.toKopecks`. Для не-RUB: `convertToRub()`.
- **Категория/направление:** Prodamus webhook — через `prodamus_product_mapping` по имени продукта; Robokassa/Tochka — `needs_classification = true` если не совпало.
- **created_by:** owner-пользователь из `app_users` (первый запрос `getAllActiveUsers`).

---

## 6. Edge Cases

| # | Ситуация | Поведение |
|---|----------|-----------|
| 1 | Tochka: ошибка сети/5xx | retry 3× (1/3/9s), затем `sync_runs.status='error'` + алерт |
| 2 | Tochka: невалидные credentials | `sync_enabled=false`, `status='skipped_bad_credentials'`, алерт |
| 3 | Tochka: statement не готов за 5 попыток | StatementNotReadyError — логируется, счёт пропускается, синк продолжается |
| 4 | Robokassa: неверная подпись | HTTP 400 `bad sign`, транзакция не создаётся |
| 5 | Prodamus: неверная подпись | HTTP 400 `bad sign`, транзакция не создаётся |
| 6 | Robokassa/Prodamus: дубль (повторный webhook) | дедуп по `external_id`, `ON CONFLICT DO NOTHING` |
| 7 | payment_status Prodamus ≠ 'success' | транзакция игнорируется, ответ HTTP 200 `success` |
| 8 | Валюта ≠ RUB | `convertToRub()`; если курса нет — `amount_rub = NULL`, добор cron'ом `0 10 * * *` |

---

## 7. Файлы

**Переписаны:**
- `src/services/integrations/tochka.ts` — реальный statement flow API
- `src/services/integrations/robokassa.ts` — webhook-помощник (удалён пуллинг)
- `src/services/integrations/prodamus.ts` — webhook-помощник (удалён пуллинг)
- `src/services/integrations/sync.ts` — только Tochka pull
- `src/server/http.ts` — urlencoded + raw text ответы

**Новые:**
- `src/server/routes/webhooks.ts` — `robokassaWebhookHandler`, `prodamusWebhookHandler`

**Изменены:**
- `src/server/index.ts` — регистрация `POST /api/webhooks/robokassa`, `POST /api/webhooks/prodamus`
- `src/config.ts` — добавлено `PRODAMUS_SECRET_KEY`
- `.env.example` — документация новых переменных и webhook URL

**Без изменений:**
- `src/services/integrations/types.ts`
- `src/db/repositories/integrations.ts`
- `src/index.ts` (cron `*/30` продолжает вызывать `syncAllSources`, теперь = только Tochka)

---

## 8. ASSUMPTION-лист (требуют сверки на реальных данных)

| # | Компонент | Предположение | Как проверить |
|---|-----------|---------------|---------------|
| A | Tochka Transaction fields | Имена полей: `transactionId`, `bookingDateTime`, `amount.amount`, `creditDebitIndicator`, `transactionInformation` | Запустить синк, залогировать raw JSON ответа |
| B | Tochka Statement flow | POST /statements → `Data.Statement.statementId`; GET polling → `Data.Statement.status='Ready'` + `Transaction[]` | Тестовый запуск с реальными credentials |
| C | Tochka scope | `accounts balances customers statements sbp payments` даёт доступ к выпискам | Проверить в ЛК разработчика Точки |
| D | Tochka client_credentials | client_credentials flow достаточен для выписок (не нужен authorization_code + consent) | Если 403 при /statements — добавить consent flow |
| E | Prodamus HMAC | PHP json_encode экранирует `/` → `\/`; рекурсивная сортировка совпадает с PHP ksort | Сравнить вычисленный `Sign` с реальным webhook на тестовом заказе |
| F | Prodamus Sign header case | Заголовок называется `sign` (lowercase) | Проверить реальный POST от Prodamus через ngrok |
