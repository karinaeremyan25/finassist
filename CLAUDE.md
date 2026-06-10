# FinAssist

## Обзор
Telegram-бот финансового учёта для Карины Еремян. Два юрлица: ИП Карина Еремян (УСН 6%) и ООО Ассургина (УСН 15%). Два направления: Курс ДПО «Психология здоровья» и Клуб «Метанойя». Три роли с одинаковым полным доступом: owner, accountant, manager.

## Стек
- Runtime: Node.js 20 LTS, TypeScript 5.4+
- Telegram: grammY 1.29+
- База данных: PostgreSQL (Supabase), postgres.js 3.4+
- AI: Anthropic Messages API, модель `claude-sonnet-4-6`
- Парсинг файлов: xlsx (SheetJS) 0.20+, papaparse 5.4+, pdf-parse 1.1+
- Валидация: Zod 3.23+
- Логирование: pino 9+
- Шедулер: node-cron 3.0+
- Деплой: Beget VPS (Ubuntu 22.04), PM2
- Курсы валют: ЦБ РФ XML API (cbr.ru, без ключа)

## Архитектура
```
src/
  index.ts            — точка входа, бот + cron
  config.ts           — env-переменные через Zod
  types.ts            — общие типы
  bot/
    bot.ts
    middleware/       — auth.ts, session.ts, error.ts
    handlers/         — start, add, import, report, funds, distribute, verify, settings
    keyboards/        — inline-клавиатуры
  services/
    claude.ts         — Anthropic API клиент
    classifier.ts     — классификация транзакций
    parser/           — prodamus-csv.ts, xlsx.ts, pdf.ts
    analytics.ts      — P&L, недельные сводки
    funds.ts          — логика фондов
    alerts.ts         — алерты
    cbr.ts            — курсы валют
  db/
    client.ts         — postgres.js
    migrations/       — 001_init.sql, 002_seed.sql, 003_seed_users.sql
    repositories/     — функции работы с таблицами
  utils/
    money.ts          — копейки ↔ рубли
    dates.ts          — периоды, USN_IP_DEADLINES, nextBusinessDay()
    logger.ts         — pino
```

## Бизнес-контекст (КРИТИЧНО)
- Все три роли (`owner`, `accountant`, `manager`) имеют **одинаковый полный доступ**: транзакции по обоим юрлицам, оба направления, фонды, настройки, аналитика, верификация
- Роли хранятся в БД для аудита (кто создал транзакцию), но **не ограничивают доступ к данным**
- Доступ только по `telegram_id` из таблицы `app_users` — первая и единственная проверка в middleware
- Изоляция в Node.js-слое (repositories) **не применяется** — все запросы без viewer-фильтров по роли, **RLS в БД отключаем**
- Все суммы хранятся в **копейках (BIGINT)**. Никогда не используй float для денег
- Soft delete через `deleted_at TIMESTAMPTZ` — физического удаления транзакций нет
- Все даты — `TIMESTAMPTZ`, UTC. Конвертация в МСК — на уровне форматирования ответов

## Правила кодирования
- TypeScript strict mode, `any` запрещён
- Именование: camelCase переменные, PascalCase типы/интерфейсы, snake_case таблицы БД
- Zod-валидация на входе каждой публичной функции сервиса
- Обработка ошибок: try/catch для всех async, глобальный error handler в `middleware/error.ts`
- Retry-стратегия по умолчанию: 3 попытки, задержки 1s / 3s / 9s (exponential backoff)
- Логировать через pino: поля `telegram_id`, `handler`, `latency_ms`; в лог **не попадают** голосовые и полный текст транзакций
- Не конкатенировать строки в SQL — только параметризованные запросы postgres.js

## Правила AI-классификации
- confidence ≥ 0.85 → сразу карточка подтверждения без уточнений
- 0.7 ≤ confidence < 0.85 → один уточняющий вопрос по наименее уверенному полю
- confidence < 0.7 → уточнения по всем неуверенным полям последовательно
- При недоступности Anthropic API → fallback: ручной формат `сумма/юрлицо/направление/категория/описание`
- Пользовательский ввод передаётся Claude обёрнутым в `<user_input>...</user_input>`

## База данных
- Все FK — с явным `ON DELETE` (CASCADE или RESTRICT)
- Все таблицы — `created_at`, `updated_at` с триггером moddatetime
- UUID через `gen_random_uuid()`, не serial
- TEXT с CHECK-ограничениями вместо enum-типов
- Дедупликация Продамуса по `external_id` через UNIQUE INDEX `WHERE external_id IS NOT NULL AND deleted_at IS NULL`

## Команды
```bash
npm run dev          # локальная разработка
npm run build        # сборка TypeScript
npm run lint         # ESLint + TypeScript check
npm test             # Vitest
pm2 start ecosystem.config.js  # запуск на VPS
pm2 logs finassist   # логи
```

## Cron-задачи (node-cron, UTC)
- `0 6 * * *` — курсы валют ЦБ РФ
- `0 6 * * 1` — еженедельная сводка (09:00 МСК)
- `0 7 * * *` — проверка налогового фонда
- `0 3 * * *` — очистка `/uploads/unparsed/` старше 7 дней
- `*/15 * * * *` — очистка просроченных FSM-сессий

## MCP
- **Context7** — актуальная документация grammY, postgres.js, Zod, Anthropic SDK
- Добавляй `use context7` к запросам по API библиотек
- Подключение: `claude mcp add --scope user --transport http context7 https://mcp.context7.com/mcp`

## Субагенты
- **database-architect** (opus) — схема БД, миграции, индексы. Вызывать при любых изменениях таблиц
- **backend-engineer** (sonnet) — handlers, services, repositories, бизнес-логика бота
- **ai-agent-architect** (opus) — промпты Claude, classifier, fallback-логика, cbr-интеграция
- **devops-engineer** (sonnet) — Beget VPS, PM2, ecosystem.config.js, деплой
- **qa-reviewer** (sonnet) — тестирование, проверка изоляции ролей, edge cases из SPEC Блок 6
