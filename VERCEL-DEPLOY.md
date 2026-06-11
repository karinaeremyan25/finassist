# Публикация Mini App на Vercel — пошагово

> Приложение уже подготовлено к Vercel (папка `api/` + `vercel.json`). Осталось опубликовать.
> Бот при этом **не трогаем** — он остаётся на своём сервере. Vercel обслуживает только приложение.
> Время: ~15 минут. Всё бесплатно (план Hobby).

---

## Что понадобится
- Аккаунт **GitHub** (бесплатный) — туда положим код.
- Аккаунт **Vercel** (бесплатный) — вход удобнее через тот же GitHub.
- Значения ключей (см. таблицу env ниже) — большинство уже есть в файле `.env`.

---

## Шаг 1. Положить код на GitHub

Без терминала — через программу **GitHub Desktop**:
1. Скачать и установить GitHub Desktop (desktop.github.com), войти/создать аккаунт GitHub.
2. **File → Add Local Repository** → выбрать папку проекта `FinAssist`.
3. Нажать **Publish repository**. Поставить галочку **«Keep this code private»** (код приватный — важно, там финансовая логика).
4. Готово — код на GitHub.

> Если деплоем занимается ваш программист — он сделает это за пару команд, GitHub Desktop не нужен.

---

## Шаг 2. Создать проект на Vercel

1. Зайти на **vercel.com** → **Sign Up** → войти через **GitHub**.
2. **Add New… → Project**.
3. В списке репозиториев выбрать **FinAssist** → **Import**.
4. **Root Directory** оставить как есть (корень репозитория, НЕ `src/app/webapp`).
5. **Framework Preset:** Other. Build Command и Output Directory подхватятся из `vercel.json` сами — ничего не меняем.
6. **Пока не нажимать Deploy** — сначала добавить переменные (Шаг 3).

---

## Шаг 3. Добавить переменные окружения

В окне импорта раскрыть **Environment Variables** и добавить по одной (имя → значение):

| Имя | Значение / где взять | Обязательно |
|-----|----------------------|:-:|
| `DATABASE_URL` | Supabase → Project Settings → Database → **Connection string → вкладка «Transaction» (порт 6543)** → скопировать. ⚠️ Именно pooled, порт **6543**, не 5432 | ✅ |
| `BOT_TOKEN` | из вашего `.env` (токен бота) | ✅ |
| `ANTHROPIC_API_KEY` | из вашего `.env` | ✅ |
| `OWNER_TG_ID` | из вашего `.env` | ✅ |
| `ACCOUNTANT_TG_ID` | из вашего `.env` | ✅ |
| `AI_MENTOR_MODEL` | `claude-opus-4-8` | ✅ |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | желательно |
| `MANAGER_TG_ID` | из `.env`, если есть менеджеры | нет |
| `ROBOKASSA_MERCHANT_LOGIN` | если подключаете Robokassa | нет |
| `ROBOKASSA_PASSWORD` | Пароль #2 Robokassa | нет |
| `PRODAMUS_SECRET_KEY` | секретный ключ Prodamus | нет |

> Применить ко всем средам (Production + Preview). `NODE_ENV` и `VERCEL` Vercel задаёт сам — добавлять не нужно.

---

## Шаг 4. Deploy

1. Нажать **Deploy**. Подождать 1–2 минуты.
2. Vercel выдаст адрес вида **`https://finassist-xxxx.vercel.app`**.
3. Проверка: открыть `https://<этот-адрес>/api/webapp/session` — должно вернуть `unauthorized` (это нормально: значит сервер жив, просто без Телеграма). Открыть корень адреса — увидите экран приложения.

---

## Шаг 5. Подключить приложение к боту (@BotFather)

1. В Телеграме открыть **@BotFather** → `/mybots` → выбрать бота.
2. **Bot Settings → Menu Button → Configure menu button** (или **Configure Mini App**).
3. Вставить адрес: `https://finassist-xxxx.vercel.app`.
4. Текст кнопки: `Аналитика`.

Готово — в чате с ботом снизу появится кнопка, открывающая приложение. Команда `/app` тоже его откроет.

---

## Шаг 6 (опционально). Вебхуки оплат

Если подключаете автоматический приём платежей — в кабинетах укажите:
- **Robokassa** → Технические настройки → Result URL (POST): `https://<адрес>/api/webhooks/robokassa`
- **Prodamus** → URL для уведомлений: `https://<адрес>/api/webhooks/prodamus`

---

## Обновления в будущем
Любая правка кода: запушить в GitHub (в GitHub Desktop — **Commit** → **Push**) — Vercel пересоберёт и обновит приложение сам.

## Если что-то не так
- Открывается белый экран / ошибка — Vercel → проект → **Deployments → Logs**, пришлите текст ошибки.
- `/api/...` отвечает 500 — почти всегда не та `DATABASE_URL` (нужна **pooled, 6543**) или не добавлена переменная. Проверьте Шаг 3.
