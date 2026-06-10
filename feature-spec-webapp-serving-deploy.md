# Feature: Раздача статики Mini App и деплой на VPS

> **Проект:** FinAssist
> **Дата:** 2026-06-10
> **Приоритет:** Medium
> **Оценка:** 2–4 часа
> **Статус:** НЕ начато
> **Субагент:** devops-engineer

---

## 1. Цель

Опубликовать собранный фронтенд Mini App (`src/app/webapp/dist`) по публичному **HTTPS**-адресу `WEBAPP_URL`, чтобы Telegram мог открыть его как Web App, а запросы `/api/*` уходили на тот же Node-сервер (порт `WEBAPP_PORT=8080`).

### Критерии приёмки
- [ ] `https://<домен>/` отдаёт `dist/index.html` Mini App.
- [ ] `https://<домен>/api/*` проксируется на Node-сервер (`WEBAPP_PORT`).
- [ ] Валидный TLS-сертификат (Let's Encrypt) — обязателен для `web_app`.
- [ ] SPA-fallback: любой путь → `index.html` (роутинг внутри клиента; сейчас `HashRouter`, fallback всё равно нужен для прямых заходов).
- [ ] Сборка фронта входит в деплой-пайплайн (`npm ci && npm run build` в `src/app/webapp`).
- [ ] PM2 поднимает бэкенд (бот + HTTP API) и переживает рестарт VPS.

---

## 2. Варианты раздачи статики (выбрать один)

### Вариант A — nginx (рекомендуется для прода)
nginx отдаёт статику `dist/` и проксирует `/api` на Node. Node занимается только API + ботом.
```nginx
server {
  listen 443 ssl;
  server_name app.psyhealth.example;
  ssl_certificate     /etc/letsencrypt/live/app.psyhealth.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.psyhealth.example/privkey.pem;

  root /var/www/finassist-webapp;          # сюда кладём содержимое dist/
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:8080;       # WEBAPP_PORT
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
  location / {
    try_files $uri $uri/ /index.html;        # SPA-fallback
  }
}
```
Деплой статики: `cp -r src/app/webapp/dist/* /var/www/finassist-webapp/`.

### Вариант B — раздача из самого Node (без nginx)
Расширить `src/server/http.ts`: если путь НЕ начинается с `/api`, отдавать файл из `src/app/webapp/dist` (с MIME-типами и fallback на `index.html`). TLS — через reverse-proxy (Caddy/nginx) или termination на хостинге. Проще, но Node берёт на себя отдачу статики.
> Если выбираем B — добавить `WEBAPP_STATIC_DIR` в config и аккуратный static-handler (защита от path traversal).

---

## 3. Деплой-пайплайн

`ecosystem.config.js` (PM2) — убедиться, что запускает `dist/index.js` (бот + HTTP API в одном процессе).

Скрипт деплоя (псевдо):
```bash
# backend
npm ci
npm run build                      # tsc → dist/
# frontend
cd src/app/webapp && npm ci && npm run build && cd -
# вариант A: выложить статику
rsync -a --delete src/app/webapp/dist/ /var/www/finassist-webapp/
# рестарт
pm2 reload ecosystem.config.js
```

### Env на VPS (добавить)
- `WEBAPP_URL` (см. [feature-spec-bot-miniapp-launch.md](feature-spec-bot-miniapp-launch.md)).
- `WEBAPP_PORT=8080`, `WEBAPP_ALLOWED_ORIGINS` (если фронт и API на разных доменах — указать домен фронта; при варианте A они на одном origin → можно пусто).

---

## 4. Edge Cases
| # | Ситуация | Поведение |
|---|----------|-----------|
| 1 | Прямой заход на `/dashboard` (не корень) | SPA-fallback `try_files → index.html` |
| 2 | `/api/*` недоступен (Node упал) | nginx 502 → фронт показывает Error-state; PM2 поднимает процесс |
| 3 | Истёк TLS-сертификат | авто-renew Let's Encrypt (`certbot renew` в cron); алерт при провале |
| 4 | CORS при разных доменах фронта/API | выставить `WEBAPP_ALLOWED_ORIGINS` = домен фронта |
| 5 | Кэш старого `index.html` | `Cache-Control: no-cache` на `index.html`, хешированные ассеты — `immutable` |

## 5. Затронутые файлы
**Изменяемые:** `ecosystem.config.js`, `.env.example`; **новое (инфра):** nginx-конфиг, скрипт деплоя; (вариант B) static-handler в `src/server/http.ts` + `WEBAPP_STATIC_DIR` в `src/config.ts`.

## 6. Чек-лист перед публикацией
- [ ] HTTPS валиден (иначе Telegram не откроет web_app).
- [ ] `web_app` URL зарегистрирован у @BotFather.
- [ ] `/api/health` отвечает 200 через публичный домен.
- [ ] Mini App открывается из бота и проходит `POST /api/webapp/session`.
- [ ] Авто-renew TLS настроен.
