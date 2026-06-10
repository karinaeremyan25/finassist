# Deploy: FinAssist на Beget VPS

Инфраструктура: Beget VPS, Ubuntu 22.04, Node.js 20 LTS, PM2, nginx (TLS termination + статика), Let's Encrypt.

Архитектура на сервере:
```
Интернет → nginx :443 → /           → /var/www/finassist-webapp/ (статика Mini App)
                      → /api/*      → Node :8080 (бот + HTTP API + webhook'и)
                                              ↕
                                         Supabase PostgreSQL
```

---

## 1. Первый деплой на чистый сервер

### Шаг 1. Подготовка сервера (один раз, под sudo)

```bash
# Клонировать репозиторий
sudo mkdir -p /opt/finassist
sudo chown $USER:$USER /opt/finassist
cd /opt/finassist
git clone <repo_url> .

# Запустить скрипт настройки сервера
sudo bash deploy/setup-server.sh
```

Скрипт установит: Node.js 20, nginx, certbot, PM2, создаст директории, скопирует nginx.conf.

### Шаг 2. Настроить домен и DNS

- В панели Beget (или регистратора домена): создать A-запись `app.example.com → <IP сервера>`.
- Дождаться propagation (обычно 1–10 минут на Beget).
- Проверить: `curl http://app.example.com/` должен вернуть ответ nginx.

### Шаг 3. Заменить домен в nginx.conf

```bash
sudo nano /etc/nginx/sites-available/finassist
# Заменить все вхождения app.example.com на реальный домен
sudo nginx -t && sudo systemctl reload nginx
```

### Шаг 4. Заполнить переменные окружения

```bash
sudo nano /etc/finassist/.env
```

Заполнить все обязательные переменные (скопировать из `.env.example`):

```dotenv
BOT_TOKEN=<токен от @BotFather>
DATABASE_URL=postgres://user:password@host:5432/dbname
ANTHROPIC_API_KEY=<ключ из console.anthropic.com>
OWNER_TG_ID=<telegram_id Карины>
ACCOUNTANT_TG_ID=<telegram_id бухгалтера>
NODE_ENV=production
WEBAPP_PORT=8080
WEBAPP_URL=https://<ваш-домен>
WEBAPP_STATIC_DIR=/var/www/finassist-webapp
LOG_LEVEL=info
```

Права на файл (секреты — только владелец):
```bash
sudo chmod 600 /etc/finassist/.env
sudo chown $USER:$USER /etc/finassist/.env
```

### Шаг 5. Выпустить TLS-сертификат

```bash
sudo certbot --nginx -d app.example.com
```

Certbot автоматически:
- Получит сертификат в `/etc/letsencrypt/live/app.example.com/`
- Обновит `/etc/nginx/sites-available/finassist` (добавит `ssl_certificate` строки)
- Настроит авто-renewal через `systemd-timer certbot.timer` (дважды в сутки)

Проверить авто-renewal:
```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

### Шаг 6. Первый деплой приложения

```bash
cd /opt/finassist
bash deploy/deploy.sh
```

Скрипт выполнит: git pull, npm ci, tsc build, миграции БД, сборку фронтенда, rsync статики, pm2 start, pm2 save.

### Шаг 7. Проверка

```bash
# Health-check через публичный домен
curl -s https://app.example.com/api/health
# Ожидаемый ответ: {"status":"ok","timestamp":"..."}

# Логи приложения
pm2 logs finassist --lines 50

# Статус процесса
pm2 status
```

---

## 2. Обновление (повторные деплои)

```bash
cd /opt/finassist
bash deploy/deploy.sh
```

Скрипт идемпотентен: при повторном запуске безопасен. PM2 использует `reload` (zero-downtime) вместо `restart`.

---

## 3. Настройка webhook-URL в кабинетах платёжных систем

После получения TLS-сертификата и успешного деплоя зарегистрируйте webhook-адреса:

### Robokassa

1. Войти в личный кабинет → выбрать магазин → **Технические настройки**.
2. В поле **ResultURL** (уведомление об оплате) указать:
   ```
   https://<ваш-домен>/api/webhooks/robokassa
   ```
3. Сохранить. Robokassa отправляет POST urlencoded на этот URL при успешном платеже.
4. Убедиться, что `ROBOKASSA_MERCHANT_LOGIN` и `ROBOKASSA_PASSWORD` (Password2) заданы в `/etc/finassist/.env`.

### Prodamus

1. Войти в личный кабинет → **Настройки** → **Уведомления**.
2. В поле **URL вебхука** указать:
   ```
   https://<ваш-домен>/api/webhooks/prodamus
   ```
3. Скопировать **Секретный ключ** из этого же раздела → вставить в `PRODAMUS_SECRET_KEY` в `.env`.
4. `PRODAMUS_API_KEY` (из раздела API) — для будущих REST-запросов, не для webhook.

### Telegram Mini App (BotFather)

После первого деплоя зарегистрировать URL Mini App:

```
/mybots → выбрать бота → Bot Settings → Menu Button → Edit Menu Button URL
```

Установить URL: `https://<ваш-домен>/`

Или через `WEBAPP_URL` в `/etc/finassist/.env` — бот сам установит кнопку при старте.

---

## 4. Переменная WEBAPP_URL

В `/etc/finassist/.env` обязательно указать:
```dotenv
WEBAPP_URL=https://<ваш-домен>
```

Эта переменная используется в двух местах:
- Бот формирует `web_app` кнопку с этим URL при команде `/app`.
- При старте бота вызывается `bot.api.setChatMenuButton(...)` с этим URL.

Без этой переменной команда `/app` выводит предупреждение "Mini App временно недоступен".

---

## 5. Откат на предыдущую версию

```bash
cd /opt/finassist

# Посмотреть историю коммитов
git log --oneline -10

# Откатиться на конкретный коммит
git checkout <commit-hash>

# Пересобрать и перезапустить
npm ci
npm run build
pm2 reload finassist --update-env
```

Для возврата на main:
```bash
git checkout main
git pull origin main
bash deploy/deploy.sh
```

---

## 6. Проверка здоровья

```bash
# HTTP-сервер Node
curl -s https://app.example.com/api/health
# {"status":"ok","timestamp":"2026-06-10T..."}

# Статика Mini App (SPA index.html)
curl -I https://app.example.com/
# HTTP/2 200, Content-Type: text/html

# Прямой доступ к Node (минуя nginx, с сервера)
curl -s http://127.0.0.1:8080/api/health

# Логи PM2
pm2 logs finassist --lines 100

# Мониторинг CPU/RAM
pm2 monit

# nginx логи
sudo tail -f /var/log/nginx/finassist_error.log
sudo tail -f /var/log/nginx/finassist_access.log
```

---

## Структура файлов деплоя

```
deploy/
  setup-server.sh   — одноразовая настройка чистого сервера (под sudo)
  deploy.sh         — повторяемый деплой (git pull → build → reload PM2)
  nginx.conf        — конфиг nginx (статика + proxy /api/)
  README.md         — этот файл

ecosystem.config.js — PM2: запуск dist/index.js с --env-file=/etc/finassist/.env
logs/
  .gitkeep          — директория для PM2-логов (logs/out.log, logs/error.log)
  out.log           — (генерируется PM2, в .gitignore)
  error.log         — (генерируется PM2, в .gitignore)
```

---

## Переменные окружения: где хранятся

| Среда       | Файл                    | Как грузится                                    |
|-------------|-------------------------|-------------------------------------------------|
| Production  | `/etc/finassist/.env`   | `node --env-file=/etc/finassist/.env` в PM2    |
| Development | `.env` (в корне проекта) | tsx автоматически грузит через dotenv или вручную |

Секреты в git не попадают: `/etc/finassist/.env` вне репозитория, `.env` в `.gitignore`.
