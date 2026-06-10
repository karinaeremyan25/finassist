# Feature: Кнопка запуска Mini App из Telegram-бота

> **Проект:** FinAssist
> **Дата:** 2026-06-10
> **Приоритет:** Medium
> **Оценка:** 1–2 часа
> **Статус:** НЕ начато

---

## 1. User Story

**Как** пользователь бота FinAssist,
**я хочу** открыть аналитический Mini App одной кнопкой прямо из чата с ботом,
**чтобы** видеть дашборд, графики и AI-наставника без выхода из Telegram.

### Критерии приёмки
- [ ] В боте есть команда `/app` (и кнопка в `/start`), открывающая Mini App.
- [ ] Кнопка — это `web_app`-кнопка Telegram (inline или reply keyboard), ведёт на `WEBAPP_URL`.
- [ ] Mini App получает валидный `initData`, бэкенд его верифицирует (`src/server/auth.ts` уже умеет).
- [ ] Доступ только для пользователей из `app_users` (та же проверка `telegram_id`).
- [ ] Тёмно-морская тема форсится самим Mini App (тему клиента не наследуем).

---

## 2. Изменения в конфигурации

`src/config.ts` (Zod):
```ts
WEBAPP_URL: z.string().url(),   // https://app.psyhealth.example — публичный HTTPS-адрес Mini App
```
`.env.example`:
```
WEBAPP_URL=                  # публичный HTTPS-URL Mini App (обязателен HTTPS для web_app)
```
> Требование Telegram: `web_app` URL должен быть **HTTPS** и зарегистрирован у @BotFather (Bot Settings → Menu Button / Web App), иначе кнопка не откроется.

---

## 3. Изменения в коде

### Новый файл
- `src/bot/handlers/miniApp.ts` — хендлер команды `/app`:
  ```ts
  import { InlineKeyboard } from 'grammy';
  // bot.command('app', ...) → ctx.reply('Откройте аналитику FinAssist',
  //   { reply_markup: new InlineKeyboard().webApp('📊 Открыть аналитику', config.WEBAPP_URL) });
  ```
- (опц.) Кнопка меню бота: `bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Аналитика', web_app: { url: config.WEBAPP_URL } } })` при старте.

### Изменяемые файлы
- `src/bot/bot.ts` — регистрация `miniAppHandler`; при старте — `setChatMenuButton` (один раз).
- `src/bot/handlers/start.ts` — добавить web_app-кнопку в приветствие `/start`.
- `src/config.ts`, `.env.example` — `WEBAPP_URL`.

---

## 4. Business Logic
- Кнопка работает только в приватных чатах (как и весь бот — см. `auth.ts` middleware).
- Mini App сам шлёт `initData` в заголовке `X-Telegram-Init-Data`; авторизация — на бэкенде, повторно (роли доступ не ограничивают).
- Никаких токенов в URL — только официальный `web_app`-механизм Telegram (initData подписан ботом).

## 5. Edge Cases
| # | Ситуация | Поведение |
|---|----------|-----------|
| 1 | `WEBAPP_URL` не HTTPS / не задан | при старте лог-ошибка, команда `/app` отвечает «Mini App временно недоступен» |
| 2 | Пользователь не в `app_users` | бэкенд Mini App вернёт 401 → экран Error («Сессия не распознана») |
| 3 | Старый клиент Telegram без web_app | fallback-текст со ссылкой (откроется в браузере, но без initData → 401; показать инструкцию обновить Telegram) |

## 6. Затронутые файлы
**Новые:** `src/bot/handlers/miniApp.ts`.
**Изменяемые:** `src/bot/bot.ts`, `src/bot/handlers/start.ts`, `src/config.ts`, `.env.example`.

## 7. План
1. `WEBAPP_URL` в config + env.
2. `handlers/miniApp.ts` (`/app` + web_app inline-кнопка).
3. Кнопка в `/start` + `setChatMenuButton` при старте.
4. Зарегистрировать у @BotFather. Связано с [feature-spec-webapp-serving-deploy.md](feature-spec-webapp-serving-deploy.md) (нужен публичный HTTPS-хостинг dist).
