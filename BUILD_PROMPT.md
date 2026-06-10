# FinAssist — Промпт для автономной сборки MVP

> Скопируй этот промпт целиком в Claude Code (новая сессия в папке FinAssist).
> Claude Code прочитает CLAUDE.md, SPEC.md и начнёт сборку, делегируя субагентам.

---

```
Запускаем автономную сборку FinAssist — Telegram-бота финансового учёта.

Прочитай файлы CLAUDE.md и SPEC.md для полного контекста. Используй plan mode
перед началом каждого крупного блока. Работай последовательно по блокам ниже,
делегируя субагентам согласно их зонам ответственности из CLAUDE.md.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 1 — ИНИЦИАЛИЗАЦИЯ ПРОЕКТА
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Создай структуру Node.js + TypeScript проекта:

- package.json (все зависимости из CLAUDE.md: grammy, postgres, @anthropic-ai/sdk,
  xlsx, papaparse, pdf-parse, zod, pino, node-cron; devDependencies: typescript,
  @types/node, eslint, vitest)
- tsconfig.json (strict mode, target ES2022, module NodeNext)
- .env.example (BOT_TOKEN, DATABASE_URL, ANTHROPIC_API_KEY, NODE_ENV)
- .gitignore (node_modules, dist, .env, uploads/)
- src/config.ts — Zod-валидация всех env-переменных при старте
- src/types.ts — общие типы проекта (Role, Entity, Direction, Transaction и др.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 2 — БАЗА ДАННЫХ (делегировать: database-architect)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- src/db/client.ts — postgres.js singleton
- db/migrations/001_init.sql — все таблицы из SPEC.md:
  app_users, entities, directions, manager_directions, categories, sources,
  fx_rates, transactions, transaction_edits, prodamus_product_mapping,
  funds, fund_transactions, settings, bot_sessions, alert_log
- db/migrations/002_seed.sql — entities (ИП + ООО), directions (ДПО + Метанойя),
  базовые категории, источники платежей
- db/migrations/003_seed_users.sql — шаблон для добавления app_users
- src/db/repositories/ — отдельный файл для каждой группы таблиц:
  transactions.ts, funds.ts, users.ts, settings.ts, sessions.ts, analytics.ts

КРИТИЧНО: суммы BIGINT (копейки), soft delete, UUID, без RLS, moddatetime триггер.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 3 — УТИЛИТЫ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- src/utils/money.ts — toKopecks(), rubles(), formatAmount() для вывода "1 500,50 ₽"
- src/utils/dates.ts — getPeriod(), USN_IP_DEADLINES (Map с дедлайнами), nextBusinessDay()
- src/utils/logger.ts — pino singleton, поля telegram_id/handler/latency_ms

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 4 — AI-СЕРВИСЫ (делегировать: ai-agent-architect)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- src/services/claude.ts — Anthropic API клиент:
  - Singleton с retry (3 попытки, 1s/3s/9s)
  - При 429: задержка 30s
  - Модель: claude-sonnet-4-6 из config.ts

- src/services/classifier.ts — AI-классификатор транзакций:
  - classify(userInput: string): Promise<ClassificationResult>
  - Поля: entity, direction, category, source, amount, currency, date
  - Confidence per field + overall confidence
  - Пользовательский ввод в <user_input>...</user_input>
  - Системный промпт динамически загружает entity/direction из БД
  - Температура: 0
  - Fallback при недоступности API: { fallback: true }

- src/services/parser/prodamus-csv.ts — парсинг CSV Продамуса:
  - parseProdamusCSV(filePath: string): Promise<ProdamusRow[]>
  - Дедупликация по external_id (UNIQUE INDEX в БД)

- src/services/parser/xlsx.ts — SheetJS, первый лист → массив строк
- src/services/parser/pdf.ts — pdf-parse, извлечение текста

- src/services/cbr.ts — курсы валют ЦБ РФ:
  - fetchRates(): парсинг XML https://www.cbr.ru/scripts/XML_daily.asp
  - getRate(currency): из таблицы fx_rates, fallback на последний известный
  - Кешировать в БД, обновлять через cron

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 5 — БИЗНЕС-СЕРВИСЫ (делегировать: backend-engineer)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- src/services/analytics.ts:
  - getPnL(period, entityId?): доходы, расходы, прибыль
  - getWeeklySummary(): сводка за неделю для cron-рассылки
  - getTaxBase(entity, period): база для расчёта налога УСН

- src/services/funds.ts:
  - getFundBalance(fundId): текущий баланс
  - addToFund(fundId, amount, description): пополнение фонда
  - distributeFunds(entityId): автораспределение по % из settings
  - Налоговый фонд: УСН 6% от доходов ИП, УСН 15% от прибыли ООО

- src/services/alerts.ts:
  - checkTaxFund(): сравнить баланс с расчётным налогом → алерт если мало
  - getUpcomingDeadlines(): ближайшие дедлайны из USN_IP_DEADLINES

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 6 — TELEGRAM БОТ (делегировать: backend-engineer)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- src/bot/middleware/auth.ts:
  Проверяет telegram_id в app_users. Если нет — отправить "нет доступа", прервать.
  ВСЕ три роли проходят одинаково — никаких дополнительных проверок по роли.

- src/bot/middleware/session.ts:
  FSM-сессии в таблице bot_sessions. getSession/setSession/clearSession.

- src/bot/middleware/error.ts:
  Глобальный обработчик. Логировать через pino. Отправить пользователю
  "Произошла ошибка, попробуйте снова" без технических деталей.

- src/bot/keyboards/ — inline keyboards:
  confirmTransaction.ts, selectEntity.ts, selectDirection.ts,
  selectCategory.ts, reportPeriod.ts, fundActions.ts

- src/bot/handlers/start.ts — /start: приветствие + главное меню
- src/bot/handlers/add.ts — добавление транзакции:
  1. Принять текст от пользователя
  2. Классифицировать через classifier.ts
  3. По confidence: подтверждение / уточняющий вопрос / серия вопросов
  4. Fallback при недоступности Claude: ручной ввод
  5. Сохранить транзакцию в БД
  6. Распределить по фондам если income

- src/bot/handlers/import.ts — импорт файлов:
  Принять CSV/XLSX/PDF, определить тип, распарсить, показать превью,
  подтвердить, сохранить в БД. Продамус: дедупликация по external_id.

- src/bot/handlers/report.ts — отчёты:
  Выбор периода (неделя/месяц/квартал/год) и типа (P&L, по категориям,
  по юрлицам). Форматировать суммы через utils/money.ts, даты в МСК.

- src/bot/handlers/funds.ts — просмотр фондов:
  Показать все фонды с балансами, кнопки действий.

- src/bot/handlers/distribute.ts — распределение по фондам вручную

- src/bot/handlers/verify.ts — верификация транзакций:
  Список неверифицированных, массовое подтверждение.

- src/bot/handlers/settings.ts — настройки:
  % распределения по фондам, список пользователей.

- src/bot/bot.ts — сборка бота: compose middleware, register handlers

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 7 — ТОЧКА ВХОДА + CRON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
src/index.ts:
- Инициализация: config → db → bot
- node-cron задачи (UTC):
  '0 6 * * *'   → cbr.fetchRates()
  '0 6 * * 1'   → analytics.getWeeklySummary() → sendToAllUsers()
  '0 7 * * *'   → alerts.checkTaxFund() → sendAlertIfNeeded()
  '0 3 * * *'   → очистка /uploads/unparsed/ старше 7 дней
  '*/15 * * * *' → очистка bot_sessions где expired_at < NOW()
- Graceful shutdown (SIGTERM → bot.stop())

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 8 — ДЕПЛОЙ (делегировать: devops-engineer)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ecosystem.config.js — PM2 конфиг (name: finassist, script: dist/index.js)
- Добавить в package.json: "start": "node dist/index.js"
- Инструкция деплоя в README.md (git pull → npm ci → npm run build → pm2 reload)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
БЛОК 9 — QA (делегировать: qa-reviewer)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
После завершения всех блоков — запустить qa-reviewer:
- Проверить auth middleware в каждом handler
- Проверить отсутствие role-фильтрации в repositories
- Проверить все суммы: только BIGINT/bigint, нет float
- Проверить параметризованность SQL-запросов
- Проверить confidence thresholds в classifier.ts
- Проверить fallback при недоступности Claude API и CBR API

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ПРАВИЛА ВСЕЙ СБОРКИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- После каждого блока — краткий отчёт: что создано, что изменено
- При неясности в SPEC — задать вопрос перед реализацией, не угадывать
- TypeScript strict, нет any, Zod на публичных функциях
- Для вопросов по API grammY, postgres.js, Zod — добавить "use context7"

Начни с плана (plan mode), покажи список файлов по блокам, дождись подтверждения.
```
