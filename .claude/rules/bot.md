---
description: Правила для grammY handlers и middleware FinAssist
globs: ["src/bot/**"]
---
- Auth middleware — первая проверка в каждом handler: `telegram_id` должен быть в `app_users`
- Все три роли (owner, accountant, manager) имеют одинаковый полный доступ — не фильтровать данные по роли в бизнес-логике
- FSM-сессии хранить в таблице `bot_sessions`, не в памяти (бот перезапускается PM2)
- Глобальная обработка ошибок — только через `middleware/error.ts`, не в каждом handler отдельно
- Retry-стратегия для внешних API: 3 попытки, задержки 1s / 3s / 9s
- Логировать через pino: `telegram_id`, `handler`, `latency_ms` — не логировать голос и полный текст
- Inline keyboards для всех подтверждений (не текстовые кнопки)
- Conversations grammY для многошаговых диалогов (добавление транзакции, импорт файла)
- Все ответы бота — в UTC, форматировать в МСК (UTC+3) перед отправкой
