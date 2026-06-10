# FinAssist — Telegram Mini App

Фронтенд Mini App «Психология Здоровья» (Vite + React + TypeScript + Tailwind).
Тёмно-морская тема (deep ocean). Бэкенд бота — отдельный Node-проект в корне репозитория.

## Запуск

```bash
npm i          # установить зависимости (внутри src/app/webapp/)
npm run dev    # dev-сервер Vite на :5173, /api проксируется на localhost:8080
npm run build  # tsc --noEmit + vite build → dist/
```

Dev-прокси `/api` → `http://localhost:8080` (порт `config.WEBAPP_PORT` бэкенда)
настроен в `vite.config.ts`. В проде Mini App собирается как статика (`base: './'`)
и раздаётся тем же бэкендом.

## Что внутри

- `src/lib/` — `api.ts` (клиент с `X-Telegram-Init-Data`), `money.ts` (копейки → «1 500,50 ₽»),
  `dates.ts` (UTC → МСК), `telegram.ts` (SDK), `types.ts`, `useAsync.ts`.
- `src/state/FilterContext.tsx` — сессия + глобальный фильтр (entity / direction / period).
- `src/components/` — `Donut`, `Header`, `BottomNav`, `TransactionRow`, `FilterBar`, `States`.
- `src/screens/` — `Dashboard`, `Transactions`, `Users`, `Settings`, `Chat` (AI-наставник).

Деньги приходят из API в **копейках** — форматирование только через `lib/money.ts`.
Даты приходят в UTC — вывод в МСК через `lib/dates.ts`.
