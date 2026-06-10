# Session Handoff — FinAssist Mini App

> **Дата фиксации:** 2026-06-10
> **Статус:** спецификации + ДИЗАЙН Mini App завершены, разработка НЕ начата
> **Следующий шаг:** разработка фронтенда `src/app/webapp/` по дизайн-сборке

---

## Дизайн готов (2026-06-10)

Дизайн-сборка экрана Dashboard завершена. Тема — тёмно-морская (deep ocean / petrol teal), бренд **«Психология Здоровья»** (НЕ «Aksari»). Стиль Dark OLED, шрифт Inter (tabular-nums).

**Артефакты:**
| Файл | Что это |
|------|---------|
| [mini-app-design.md](mini-app-design.md) | Полная дизайн-сборка: палитра (CSS-токены + Tailwind), типографика, spacing, компоненты, макет Dashboard, спека donut, состояния, чек-лист |
| [mini-app-preview.html](mini-app-preview.html) | Живой self-contained прототип Dashboard (SVG-донат, без библиотек, открывается в браузере) |
| `aksari_finance.png` | Исходный референс-лейаут (пипетка взята отсюда) |

**Палитра** снята пипеткой с референса: фон `#0B2926→#0F3B33`, гребень `#1F584A`, поверхности `#143733/#1A473E`, акцент-бирюза `#2DD4BF`. Полные токены — в `mini-app-design.md` §2.

**Donut на главном (math-clean part-to-whole):** целое = Выручка (100%), 5 непересекающихся долей по убыванию: Расходы `#FB7A6E` / Прибыль `#34D399` / Фонд «Кредиты» `#FBBF24` / Налоги `#94A3B8` / Фонд «Благодарность» `#38BDF8`. Центр кольца = доля Прибыли (margin %). Прибыль = `Выручка − Расходы − Налоги − Фонды` (остаток, в БД не хранится). Бэкенд должен отдавать кастомные фонды в `fundStatus.gratitudeFund` / `creditFund`. Детали и формула — `mini-app-design.md` §6.

**Дизайн-скиллы** установлены в `~/.claude/skills/` (ui-ux-pro-max, design, design-system, ui-styling, brand) из github.com/nextlevelbuilder/ui-ux-pro-max-skill. Можно переиспользовать при разработке компонентов.

**Старт сессии разработки:** «Разрабатываем фронтенд Mini App FinAssist. Дизайн — в mini-app-design.md, прототип — mini-app-preview.html. Стек React + Vite + Tailwind. Начнём со скелета src/app/webapp/ и экрана Dashboard.»

---

---

## Где мы остановились

Прописывание спеки Mini App завершено на уровне трёх документов. Сегодня навели порядок: развели **платформенный слой** и **спеку AI-агента** по разным файлам (раньше инфраструктура была ошибочно в спеке агента).

### Карта документов

| Файл | Что описывает | Уровень |
|------|---------------|---------|
| [mini-app.architector.md](mini-app.architector.md) | Архитектура + **источники данных/синхронизация** (Robokassa/Prodamus/Tochka, cron) + **безопасность** + edge cases | Платформа |
| [feature-spec-mini-app-ai-agent.md](feature-spec-mini-app-ai-agent.md) | Дашборд, KPI, графики, инсайты, session-авторизация | Фича: аналитика |
| [ai-agent-spec.md](ai-agent-spec.md) | AI-наставник (инлайн-чат), `/api/ai-chat` — только сам чат, ссылается на платформу | Фича: AI-агент |

**Принцип разделения (зафиксирован):** AI-агент *читает* данные; платформа их *синхронизирует и хранит*. Синхронизация существовала бы и без агента → она в общей спеке.

---

## Что по факту в коде (обновлено 2026-06-10, разработка стартовала)

- ✅ `src/services/miniApp.ts` — backend-сервис финансовой сводки.
- ✅ **`src/server/`** — HTTP-API Mini App на `node:http` (без фреймворка): `http.ts` (роутер, CORS, лимит тела 256KB, bigint→number), `auth.ts` (верификация Telegram initData HMAC-SHA256 + проверка `app_users`, обновление `last_seen`), `routes/{session,analytics,users,aiChat}.ts`. Порт `WEBAPP_PORT` (8080), запускается рядом с ботом в `src/index.ts`.
- ✅ Эндпоинты: `POST /api/webapp/session`, `GET /api/analytics/{summary,charts,insights,transactions}`, `GET /api/webapp/users`, `POST /api/ai-chat` (+alias `/api/webapp/ai/chat`), `GET /api/health`. `summary.fundStatus` отдаёт `taxFund,reserveFund,gratitudeFund,creditFund,profitFund` (копейки) — donut сходится.
- ✅ **`src/services/miniAppAi.ts`** — AI-наставник на `claude-opus-4-8` (`config.AI_MENTOR_MODEL`, temp 0.4). `callClaude` обратносовместимо расширен опциональными `model`/`temperature`.
- ✅ **`src/app/webapp/`** — фронтенд Mini App (изолированный Vite+React+TS+Tailwind пакет, свой `package.json`/`node_modules`). Экраны: Dashboard (с donut по §6), Transactions, Users, Settings, Chat (AIChatWidget). Состояния Loading/Empty/Error/Partial. `npm run build` — чисто.
- ✅ Миграция `db/migrations/004_add_last_seen.sql` (нужна `app_users.last_seen`).
- ❌ Нет `src/services/integrations/` (robokassa/prodamus/tochka) — синхронизация источников (платформенный слой) ещё не реализована.
- ❌ Нет `src/bot/handlers/miniApp.ts` — кнопка запуска Mini App из бота.

### Сборка / проверки
- `npx tsc --noEmit` (корень) — **0 ошибок** (webapp исключён из корневого `tsconfig`, у него свой).
- `npm run build` — собирает `dist/` (бэкенд). `cd src/app/webapp && npm run build` — собирает фронтенд.
- ⚠️ `npm run lint`: tsc-половина проходит; **eslint-половина падала и ДО этой сессии** — в проекте нет `.eslintrc`/`eslint.config.*`. Нужно добавить конфиг ESLint (отдельная задача, не блокер сборки).

### Бэклог нереализованных задач (спеки готовы)
| Файл | Задача | Приоритет |
|------|--------|-----------|
| [feature-spec-integrations-sync.md](feature-spec-integrations-sync.md) | Синхронизация Robokassa/Prodamus/Tochka + cron + audit | High |
| [feature-spec-bot-miniapp-launch.md](feature-spec-bot-miniapp-launch.md) | Кнопка запуска Mini App из бота (`/app`, web_app) | Medium |
| [feature-spec-webapp-serving-deploy.md](feature-spec-webapp-serving-deploy.md) | Раздача статики `webapp/dist` + HTTPS/nginx/PM2 деплой | Medium |
| [tech-debt-backlog.md](tech-debt-backlog.md) | Мелочи QA: LRU promptCache, entity-изоляция наставника, ESLint-конфиг, code-splitting, healthcheck | Low |

---

## Открытые вопросы (РЕШЕНЫ 2026-06-10)

1. ✅ **Модель синхронизирована.** AI-наставник Mini App → **Claude Opus 4.8** (`claude-opus-4-8`), грузится из `config.AI_MENTOR_MODEL`. Классификатор транзакций остаётся на `claude-sonnet-4-6` (`config.CLAUDE_MODEL`) — детерминированный разбор. Опус — для качественного диалога наставника. Обновлено в `ai-agent-spec.md` и `mini-app.architector.md`.
2. ✅ **Стек фронтенда подтверждён:** React + Vite + Tailwind. Дизайн готов (`mini-app-design.md`).
3. ✅ **Дизайн готов** (блок «Дизайн готов» выше).
4. ✅ **Donut / кастомные фонды:** `/api/analytics/summary` → `fundStatus` расширен полями `gratitudeFund` и `creditFund` (копейки). `taxFund`/`reserveFund` — из балансов фондов; `gratitudeFund`/`creditFund` — из транзакций за период (`getGratitudeFundMetrics` / `getLoanExpenseMetrics`). Обновлено в обеих API-спеках.

---

## Точка входа для следующей сессии: РАЗРАБОТКА

> Дизайн готов (см. блок выше). Ниже — карта экранов для реализации.

Экраны Mini App (дизайн Dashboard готов, остальные — по тем же токенам):
- **Dashboard** `/dashboard` — KPI, графики, карточки инсайтов
- **Transactions** `/transactions` — таблица транзакций с фильтрами
- **Users** `/users` — пользователи и доступ
- **Settings** `/settings` — выбор юрлица, направления, периода
- **AI-наставник** — инлайн-чат (виджет `AIChatWidget`)

Состояния каждого экрана: Loading (skeleton) / Empty / Error / Ready.

**Старт новой сессии:** «Разрабатываем фронтенд Mini App FinAssist. Дизайн — в mini-app-design.md, прототип — mini-app-preview.html, контекст — в SESSION_HANDOFF.md. Стек React + Vite + Tailwind. Начнём со скелета src/app/webapp/ и экрана Dashboard.»
