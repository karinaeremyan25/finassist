# FinAssist

Telegram-бот финансового учёта для ИП Еремян и ООО Ассургина. Два направления: курс ДПО «Психология здоровья» и клуб «Метанойя».

## Стек

Node.js 20 LTS, TypeScript 5.4, grammY, PostgreSQL (Supabase), Anthropic Claude, PM2.

## Требования

- Node.js >= 20.0.0
- PM2 (`npm install -g pm2`)
- PostgreSQL-база через Supabase (строка подключения `DATABASE_URL`)

## Первоначальная установка

```bash
git clone <repo-url> finassist && cd finassist
npm ci
cp .env.example .env
```

Заполнить `.env`:

```
BOT_TOKEN=
DATABASE_URL=
ANTHROPIC_API_KEY=
OWNER_TG_ID=
ACCOUNTANT_TG_ID=
```

Применить миграции:

```bash
psql $DATABASE_URL < db/migrations/001_init.sql
psql $DATABASE_URL < db/migrations/002_seed.sql
psql $DATABASE_URL < db/migrations/003_seed_users.sql
```

Создать директорию для загрузок:

```bash
mkdir -p uploads/unparsed
chmod 755 uploads
```

## Сборка и запуск

```bash
npm run build
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

## Обновление

```bash
git pull origin main
npm ci
npm run build
pm2 reload finassist --update-env
pm2 save
```

## Логи и мониторинг

```bash
pm2 logs finassist          # стрим логов
pm2 logs finassist --lines 100
pm2 monit                   # CPU / RAM
pm2 status
```

Файлы логов: `logs/out.log`, `logs/error.log`.

## Команды разработки

| Команда | Описание |
|---|---|
| `npm run dev` | Локальный запуск с hot-reload (tsx watch) |
| `npm run build` | Компиляция TypeScript в `dist/` |
| `npm run lint` | ESLint + проверка типов |
| `npm test` | Vitest |

## Переменные окружения (production)

На сервере переменные хранятся в `/etc/finassist.env` и подключаются через `env_file` в ecosystem.config.js или `pm2 set`. Никогда не коммитить `.env` в репозиторий.
