# FinAssist — Спека интеграции Lava.top

> Задача для Claude Code: добавить Lava.top как четвёртый источник дохода.
> Репозиторий: https://github.com/karinaeremyan25/finassist

---

## Контекст архитектуры (обязательно прочитать перед началом)

- Весь API — **один catch-all роут** `api/router.ts` + rewrite. **Не создавать новые файлы в `/api/`**. Новые эндпоинты регистрируются только в `src/server/index.ts` → `buildRouter()`.
- Запросы к БД — **строго последовательные** (`await` по одному, никакого `Promise.all` — вешает pgBouncer). Пул `max:5, prepare:false`.
- Суммы — **только через `src/utils/money.ts`** (`toKopecks`, `rubles`). Никаких `parseFloat`, `*100`, `/100` вручную.
- TypeScript strict, `any` запрещён.
- Параметризованные SQL-запросы (никакой конкатенации строк).
- Zod-валидация входа публичных функций сервисов.
- Логировать только метаданные (источник, статус подписи, количество). **Никаких сумм, email, тел запросов** в логах.

---

## Шаг 1 — Миграция БД

Файл: `db/migrations/YYYYMMDD_add_lava_source.sql`

```sql
-- 1. Добавить источник Lava.top
INSERT INTO sources (code, display_name, is_active, sync_enabled)
VALUES ('lava', 'Lava.top', true, false)
ON CONFLICT (code) DO NOTHING;

-- 2. Добавить категории доходов (опционально — если нужна детализация в P&L)
INSERT INTO categories (code, display_name, flow_type, is_active)
VALUES
  ('lava_course', 'Lava.top — Курс ДПО', 'income', true),
  ('lava_club',   'Lava.top — Клуб Метанойя', 'income', true)
ON CONFLICT (code) DO NOTHING;
```

---

## Шаг 2 — Сервис `src/services/integrations/lava.ts`

Создать по образцу `src/services/integrations/prodamus.ts`.

### Что делает сервис

1. **Проверка подписи Lava.top**
   - Изучить документацию: https://gate.lava.top/docs (Swagger UI, нужна авторизация).
   - Ожидаемый механизм: HMAC-подпись в заголовке (скорее всего `X-Signature` или аналог).
   - Ключ из `process.env.LAVA_WEBHOOK_SECRET`.
   - При несовпадении подписи → `throw new Error('bad sign')` → роут вернёт 400.

2. **Парсинг payload вебхука**
   Lava.top отправляет JSON (в отличие от Продамуса/Робокассы с urlencoded).
   Ожидаемые поля (уточнить по Swagger):
   ```
   payment.id        — уникальный ID платежа (для external_id)
   payment.status    — обрабатывать только 'success' / 'paid' (уточнить по доке)
   payment.amount    — сумма (уточнить: в рублях целым или с копейками)
   payment.currency  — валюта ('RUB', 'USD', 'EUR' и т.д.)
   offer.id          — ID оффера (для определения продукта)
   buyer.email       — email покупателя (НЕ логировать)
   ```

3. **Определение продукта по `offer.id`**
   Маппинг `offerId → { entity_id, direction_id, category_code }`:
   ```typescript
   // Заполнить реальными offer_id из личного кабинета Lava.top
   const OFFER_MAP: Record<string, {
     entity_id: string
     direction_id: string
     category_code: string
   }> = {
     'OFFER_ID_COURSE': {
       entity_id: '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068',   // ИП
       direction_id: 'b17eb69e-4bd3-441f-8a0c-57734d56840c', // DPO
       category_code: 'lava_course',
     },
     'OFFER_ID_CLUB': {
       entity_id: 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d',   // ООО
       direction_id: 'ac773f21-0f0d-4772-8baf-15cac941c122', // METANOIA
       category_code: 'lava_club',
     },
   }
   ```
   Если `offer.id` не найден в маппинге → залогировать предупреждение, вернуть 200 (чтобы Lava не ретраила), не создавать транзакцию.

4. **Конвертация суммы**
   ```typescript
   // Уточнить формат суммы в доке Lava.top:
   // - если рубли с копейками (123.45) → toKopecks(amount)
   // - если уже в копейках (12345)     → BigInt(amount)
   const amountKopecks = toKopecks(payload.payment.amount)
   ```
   Для валютных платежей (USD/EUR):
   - `amount` = оригинальная сумма в валюте (копейки)
   - `currency` = валюта из payload
   - `amount_rub` = рублёвый эквивалент (если Lava передаёт — взять из payload; если нет — `null`, проставить вручную)
   - `fx_rate` = курс (если есть в payload)

5. **Дедупликация и вставка транзакции**
   ```typescript
   const external_id = `lava_${payload.payment.id}`

   // Получить source_id последовательно (не Promise.all!)
   const source = await db`SELECT id FROM sources WHERE code = 'lava' AND deleted_at IS NULL LIMIT 1`
   const category = await db`SELECT id FROM categories WHERE code = ${categoryCode} AND deleted_at IS NULL LIMIT 1`

   await db`
     INSERT INTO transactions (
       flow_type, amount, currency, amount_rub, fx_rate,
       entity_id, direction_id, category_id, source_id,
       occurred_at, description, external_id,
       created_by, pnl_category,
       is_personal, needs_review, needs_classification, verified,
       classifier_confidence
     ) VALUES (
       'income',
       ${amountKopecks}, ${currency}, ${amountRub}, ${fxRate},
       ${entityId}, ${directionId}, ${category[0].id}, ${source[0].id},
       ${occurredAt}, ${description}, ${external_id},
       ${SYSTEM_USER_TELEGRAM_ID}, 'income',
       false, false, false, true,
       1.0
     )
     ON CONFLICT (external_id)
     WHERE external_id IS NOT NULL AND deleted_at IS NULL
     DO NOTHING
   `
   ```
   `SYSTEM_USER_TELEGRAM_ID` — взять из существующего кода (как делает Продамус/Робокасса).

6. **Возвращаемое значение**
   ```typescript
   return { processed: true, external_id, skipped: false }
   // или при дедупе:
   return { processed: false, external_id, skipped: true }
   ```

---

## Шаг 3 — Webhook-роут в `src/server/routes/webhooks.ts`

Добавить обработчик рядом с `lavaWebhookHandler` Продамуса:

```typescript
export async function lavaWebhookHandler(req: Request): Promise<Response> {
  const logger = getLogger('lava-webhook')

  // 1. Прочитать тело как JSON
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('bad request', { status: 400 })
  }

  // 2. Получить подпись из заголовка (уточнить имя заголовка по доке Lava.top)
  const signature = req.headers.get('X-Signature') ?? ''

  // 3. Обработать через сервис
  try {
    const result = await handleLavaWebhook(body, signature)
    logger.info({ result }, 'lava webhook processed')
    return new Response('ok', { status: 200 })
  } catch (err) {
    if (err instanceof Error && err.message === 'bad sign') {
      logger.warn('lava webhook bad signature')
      return new Response('bad sign', { status: 400 })
    }
    logger.error({ err }, 'lava webhook error')
    // Вернуть 200 при внутренней ошибке чтобы Lava не ретраила бесконечно
    return new Response('ok', { status: 200 })
  }
}
```

---

## Шаг 4 — Регистрация роута в `src/server/index.ts`

В функции `buildRouter()` добавить рядом с Продамусом/Робокассой:

```typescript
router.post('/api/webhooks/lava', lavaWebhookHandler)
```

---

## Шаг 5 — Переменные окружения

Добавить в `.env.example` и в Vercel (Settings → Environment Variables):

```
LAVA_WEBHOOK_SECRET=   # секретный ключ для верификации подписи вебхука
```

---

## Шаг 6 — P&L (если нужна детализация)

Файл: `src/db/repositories/pnl.ts`, массив/объект `PnlIncomeSources`.

Добавить `lava` как отдельный источник дохода рядом с `prodamus` и `robokassa`, если такая детализация нужна для P&L-отчёта.

---

## Что нужно уточнить перед запуском (TODO для Карины)

1. **Offer IDs** — зайти в Lava.top → Products, скопировать `offer_id` для курса ДПО и клуба Метанойя, вставить в `OFFER_MAP` в сервисе.
2. **Имя заголовка подписи** — проверить в документации Lava.top (Swagger → webhooks), как именно передаётся подпись (заголовок, поле в теле).
3. **Формат суммы** — рубли (123.45) или копейки (12345) — уточнить в Swagger.
4. **`LAVA_WEBHOOK_SECRET`** — получить в личном кабинете Lava.top → Integrations → API Key/Webhook Secret → добавить в Vercel.
5. **Webhook URL** — зарегистрировать в Lava.top: `https://финассист-домен/api/webhooks/lava`, тип события «Результат платежа» + «Регулярный платёж» (два вебхука).

---

## Чеклист после реализации

- [ ] Миграция применена в Supabase
- [ ] `LAVA_WEBHOOK_SECRET` добавлен в Vercel
- [ ] Offer IDs прописаны в `OFFER_MAP`
- [ ] Два вебхука зарегистрированы в Lava.top
- [ ] Тестовый платёж прошёл → транзакция появилась в таблице `transactions`
- [ ] Дедупликация работает (повторный вебхук → `skipped: true`, дубля нет)
- [ ] Транзакция видна в P&L и Отчётах Mini App
