# Tech Debt Backlog — FinAssist

> **Дата:** 2026-06-10
> **Источник:** остаточные находки QA-ревью backend Mini App (не блокеры) + инфраструктурные пробелы.
> Каждый пункт — самостоятельная мелкая задача. Приоритет внутри = порядок.

---

## TD-1. Промпт-кэш в `claude.ts` без ограничения размера (memory leak)

> **Severity:** minor · **Оценка:** 30–60 мин · **Файл:** `src/services/claude.ts:29–32, 239–247`

`promptCache` — `Map` без верхней границы. TTL (5 мин) проверяется только при `get`; записи, к которым больше не обращаются, не вытесняются → на долгоживущем процессе (PM2) карта растёт неограниченно.

**Решение:** LRU с лимитом (например, 500 записей) — мини-реализация на `Map` (delete+set для перемещения в «хвост», eviction по размеру) или зависимость `lru-cache`. Заодно периодически чистить просроченные.

**Критерий:** при превышении лимита старые записи вытесняются; поведение классификатора/наставника не меняется.

---

## TD-2. AI-наставник: полная entity-изоляция контекста

> **Severity:** minor (корректность) · **Оценка:** 2–3 ч · **Файл:** `src/services/miniAppAi.ts` (`buildDataContext`)

Сейчас заголовочные доход/расход уже учитывают выбранное юрлицо (через `getSummaryTotals`), но **топ-категории, балансы фондов и overview-метрики** (`getMiniAppFinancialOverview`, `getTopExpenseCategories`, `getCategoryExpenses`) считаются по **всему аккаунту** — это честно помечено в промпте («по всему аккаунту»), но не отфильтровано по `entity_id`.

**Решение:** добавить entity-aware параметр в эти агрегаты:
- `getTopExpenseCategories(from, to, limit, entityId?)`, `getCategoryExpenses(from, to, categoryIds?, entityId?)` — опциональный фильтр `AND t.entity_id = ${entityId}`.
- Для overview/фондов — оценить, нужна ли per-entity разбивка (фонды в проекте общие; возможно, оставить account-wide осознанно).

**Критерий:** при выбранном юрлице срез данных наставника соответствует тому же юрлицу, что и дашборд.

---

## TD-3. Нет конфигурации ESLint (`npm run lint` падает)

> **Severity:** minor (DX/CI) · **Оценка:** 1–2 ч · **Пред-существующий пробел**

В проекте **нет** `.eslintrc*` / `eslint.config.*`, поэтому `npm run lint` (`eslint src --ext .ts && tsc --noEmit`) валится на eslint-половине. tsc-половина проходит. Зависимости (`@typescript-eslint/*`, `eslint@8`) в `package.json` есть.

**Решение:** добавить `.eslintrc.cjs` (или flat `eslint.config.js`) под TS strict:
- parser `@typescript-eslint/parser`, plugin `@typescript-eslint`, `eslint:recommended` + `plugin:@typescript-eslint/recommended`.
- правила в духе CLAUDE.md: запрет `any` (`@typescript-eslint/no-explicit-any: error`), `no-floating-promises`, camelCase/PascalCase.
- `ignorePatterns`: `dist`, `node_modules`, `src/app/webapp` (у фронта свой линт/tsconfig).

**Критерий:** `npm run lint` отрабатывает без ошибок конфигурации; реальные находки исправлены или осознанно заглушены.

---

## TD-4. Bundle Mini App > 500 KB (recharts) — code-splitting

> **Severity:** trivial · **Оценка:** 30 мин · **Файл:** `src/app/webapp/vite.config.ts`

Vite warning: чанк `index.js` ~560 KB (recharts тяжёлый). На мобильном Mini App желательно ужать.

**Решение:** `build.rollupOptions.output.manualChunks` — вынести `recharts`/`react` в отдельные чанки; либо `lazy()`-импорт Donut/графиков, либо лёгкая SVG-реализация доната (в `mini-app-preview.html` донат сделан на чистом SVG — можно переиспользовать и убрать recharts вовсе).

**Критерий:** основной чанк < 300 KB gzip или донат без recharts.

---

## TD-5. Healthcheck-пинг для HTTP-сервера

> **Severity:** trivial · **Оценка:** 20 мин

`HEALTHCHECKS_URL` уже в config. Можно пинговать его из cron вместе с проверкой, что HTTP-сервер Mini App слушает порт (`/api/health`), а не только бот.

**Решение:** в существующий мониторинг добавить self-check `GET http://127.0.0.1:${WEBAPP_PORT}/api/health` и пинг `HEALTHCHECKS_URL` при успехе.

---

## Сводка
| ID | Что | Severity | Оценка |
|----|-----|----------|--------|
| TD-1 | LRU для promptCache | minor | 30–60 мин |
| TD-2 | Entity-изоляция контекста наставника | minor | 2–3 ч |
| TD-3 | Конфиг ESLint | minor | 1–2 ч |
| TD-4 | Code-splitting / SVG-донат | trivial | 30 мин |
| TD-5 | Healthcheck HTTP-сервера | trivial | 20 мин |

> Связанные крупные задачи вынесены в отдельные спеки: [feature-spec-integrations-sync.md](feature-spec-integrations-sync.md), [feature-spec-bot-miniapp-launch.md](feature-spec-bot-miniapp-launch.md), [feature-spec-webapp-serving-deploy.md](feature-spec-webapp-serving-deploy.md).
