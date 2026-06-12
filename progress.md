# FinAssist — журнал прогресса

> Краткое резюме сделанного. Обновлено: 2026-06-12.

## Что это
Telegram Mini App финансового учёта для Карины Еремян (ИП Карина Еремян УСН 6% + ООО Ассургина УСН 15%; направления: Курс ДПО «Психология здоровья», Клуб «Метанойя»). Стек: Node 20 + TS, React+Vite (webapp), Supabase Postgres, деплой на **Vercel**.

## Боевые адреса и идентификаторы
- Прод: **https://finassist-virid.vercel.app**
- Vercel team: `team_WKR28xYnzRbd3V8dmLxWS18f`, project: `prj_J3KbLVGain3NHyv3WwgBnn3xlX7F`
- GitHub: `karinaeremyan25/finassist`, ветка `main` (автодеплой при пуше)
- Владелец (telegram_id): `1631024`

---

## ✅ Сделано

### 1. Mini App запущен и работает
- Авторизация Telegram initData (принимаем оба варианта подписи — с `signature` и без).
- Экраны: Главная (дашборд + donut), Отчёты, Фонды, Чат (AI-наставник).
- Запросы к БД в serverless — **строго последовательно** (pgBouncer виснет на `Promise.all` → 504).
- Сериализация bigint (суммы в копейках).

### 2. Реальные данные загружены
- **Эквайринг (Платформа ОФД):** 12 операций за май, доход **341 828 ₽** (source `prodamus`).
- **Робокасса:** 2 операции за декабрь 2025 (1 998 ₽, source `robokassa`) — выгружено CSV-реестром (технические настройки/webhook в кабинете недоступны — «Shop settings» серые).

### 3. AI-наставник (Opus 4.8) починен и улучшен
- Причина зависаний: новые модели **отклоняют параметр `temperature`** (400) → убрали его из вызова Claude.
- Последовательные запросы вместо `Promise.all`.
- Промпт: приветствие + читабельное оформление (абзацы/пункты). Чат сохраняет переносы строк (`whitespace-pre-line`).
- Видит реальные данные пользователя.

### 4. Миграция 006 (применена на БД)
- Источники `robokassa`, `tochka`.
- Фонды `gratitude`, `credit`, `land` (+ уже были tax_ip/tax_ooo/reserve_ip/reserve_ooo/development_ip/development_ooo/personal).
- `fund_transactions.source_transaction_id` (связь траты фонда с расходом — «куда/зачем»).
- `funds.tochka_account_id` (маппинг фонд ↔ счёт-копилка Точки).
- Категории `internal_transfer`, `acquiring_settlement` (антидвоение).

### 5. Backend интеграций (код готов)
- `GET /api/analytics/funds` — фонды + последние движения (экран «Фонды»).
- `summaryHandler.fundStatus` — по реальным кодам (tax_ip+tax_ooo и т.д.).
- Robokassa webhook — под реальную схему (created_by = bigint OWNER_TG_ID).
- Точка: callback + sync (изначально под OAuth — **переводим на JWT**, см. ниже).

### 6. Frontend
- Вкладка **«Счета» → «Фонды»** + экран фондов (карточки: баланс + движения in/out).
- Список операций **сгруппирован по дням** (направление·категория, цвет/знак).
- Donut показывает расходы при `totalExpense > 0`.
- Убрана временная отладка (детали ошибок только в логах, не в ответах клиенту).

---

## 🔑 Точка — ПОДКЛЮЧЕНА по JWT (read-only)
- Создан **JWT-ключ** в кабинете Точки (i.tochka.com): доступы только **просмотр реквизитов / остатка / выписок** (без платежей — безопасно). Бессрочный.
- Токен лежит в `.env` → `TOCHKA_JWT_TOKEN`. **Ещё нужно добавить его в Vercel env.**
- API работает: `https://enter.tochka.com/uapi/open-banking/v1.0/...`, заголовок `Authorization: Bearer <JWT>`.
- **7 счетов ИП = фонды-копилки.** Текущие балансы (на 12.06):
  410 541 · 154 128 · 146 778 · 135 707 · 14 046 · 11 659 · 5 808 ₽.

### Структура API Точки (выяснено опытным путём)
- `GET /accounts` → `Data.Account[]` (accountId, currency, accountSubType).
- `GET /accounts/{id}/balances` → `Data.Balance[]` (type `ClosingAvailable` = текущий баланс).
- `POST /statements` body `{Data:{Statement:{accountId, startDateTime, endDateTime}}}` → `Data.Statement.statementId`, status `Created`.
- `GET /accounts/{id}/statements/{sid}` → **`Data.Statement` это МАССИВ**; берём `[0].Transaction[]` когда `[0].status === 'Ready'`.
- Транзакция: `transactionId`, `creditDebitIndicator` (Credit/Debit), `Amount.amount` (рубли), `documentProcessDate`, `description`, `CreditorParty/DebtorParty`, `CreditorAccount.identification`.

---

## ⏭️ Следующие шаги (Точка)
1. **Добавить `TOCHKA_JWT_TOKEN` в Vercel** (Project → Settings → Environment Variables) + в `config.ts`.
2. **Поправить парсер выписки**: `Data.Statement` — массив, операции в `[0].Transaction` при статусе `Ready`.
3. **Маппинг 7 счетов → фонды**: Карина подскажет, какой счёт = какой фонд (Налог/Резерв/Благодарность/Кредиты/Земля/Личный/основной) → записать `funds.tochka_account_id`, синхронизировать `funds.balance`.
4. **Загрузить операции** (доходы=Credit, расходы=Debit). Учесть:
   - переводы между её же счетами = `internal_transfer` (не в P&L);
   - зачисление эквайринга = `acquiring_settlement` (не задваивать с уже загруженными 341 828 ₽).
5. **Переписать `src/services/integrations/tochka.ts`** с OAuth на **JWT Bearer** (проще: токен напрямую, без обмена/refresh).
6. Cron на регулярную синхронизацию (Vercel Cron 1×/день + кнопка «Обновить» в приложении).

## Открытые вопросы
- Доход бухгалтера 857 015 ₽ vs приложение 341 828 ₽ — разницу закроет загрузка операций Точки (после п.4).
- ООО Ассургина — отдельный логин/JWT Точки (текущий ключ только для ИП).
- Какой из 7 счетов основной (расчётный), а какие — фонды-копилки.
