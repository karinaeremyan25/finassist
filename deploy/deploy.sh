#!/usr/bin/env bash
# deploy/deploy.sh — идемпотентный деплой FinAssist на Beget VPS.
#
# Запускать из корня проекта от имени пользователя PM2:
#   cd /opt/finassist && bash deploy/deploy.sh
#
# Предусловия:
#   - Node 20 LTS и npm установлены
#   - PM2 установлен глобально (npm install -g pm2)
#   - /etc/finassist/.env существует и заполнен (см. setup-server.sh)
#   - /var/www/finassist-webapp/ существует и доступен для записи (см. setup-server.sh)
#   - nginx установлен и настроен (см. setup-server.sh + nginx.conf)

set -euo pipefail

# ── Цвета для вывода ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

step() { echo -e "${GREEN}[DEPLOY]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ── Проверка рабочей директории ──────────────────────────────────────────────
if [[ ! -f "package.json" ]]; then
    fail "Запускать из корня проекта (package.json не найден). cd /opt/finassist"
fi

# ── Проверка env-файла ───────────────────────────────────────────────────────
ENV_FILE="/etc/finassist/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
    fail "${ENV_FILE} не найден. Создайте его по инструкции в deploy/README.md."
fi

# ── Переменные ───────────────────────────────────────────────────────────────
WEBAPP_STATIC_SRC="src/app/webapp/dist"
WEBAPP_STATIC_DST="/var/www/finassist-webapp"
PM2_APP_NAME="finassist"

# ── 1. Получение изменений из git ────────────────────────────────────────────
step "1/8 git pull origin main"
git pull origin main

# ── 2. Установка зависимостей бэкенда ───────────────────────────────────────
step "2/8 npm ci (backend)"
npm ci --prefer-offline

# ── 3. Сборка TypeScript ─────────────────────────────────────────────────────
step "3/8 npm run build (tsc → dist/)"
npm run build

# ── 4. Миграции БД ───────────────────────────────────────────────────────────
step "4/8 npm run migrate"
# Миграции запускаем с env-файлом, чтобы получить DATABASE_URL.
node --env-file="${ENV_FILE}" scripts/migrate.mjs || fail "Миграции завершились с ошибкой."

# ── 5. Сборка фронтенда Mini App ─────────────────────────────────────────────
WEBAPP_DIR="src/app/webapp"
if [[ -f "${WEBAPP_DIR}/package.json" ]]; then
    step "5/8 Сборка фронтенда (${WEBAPP_DIR})"
    (
        cd "${WEBAPP_DIR}"
        npm ci --prefer-offline
        npm run build
    )
else
    warn "5/8 ${WEBAPP_DIR}/package.json не найден — пропускаем сборку фронтенда."
fi

# ── 6. Выкладка статики ──────────────────────────────────────────────────────
if [[ -d "${WEBAPP_STATIC_SRC}" ]]; then
    step "6/8 rsync статики → ${WEBAPP_STATIC_DST}"
    if [[ ! -d "${WEBAPP_STATIC_DST}" ]]; then
        fail "${WEBAPP_STATIC_DST} не существует. Запустите setup-server.sh."
    fi
    rsync -a --delete --checksum \
        "${WEBAPP_STATIC_SRC}/" "${WEBAPP_STATIC_DST}/"
    step "   Статика выложена."
else
    warn "6/8 ${WEBAPP_STATIC_SRC} не найден — статика не выложена."
fi

# ── 7. Перезапуск PM2 ────────────────────────────────────────────────────────
step "7/8 PM2 reload / start"
# pm2 reload — zero-downtime (SIGTERM → новый процесс → старый завершается).
# Если приложение ещё не запущено — pm2 reload вернёт ненулевой код → start.
if pm2 describe "${PM2_APP_NAME}" > /dev/null 2>&1; then
    pm2 reload ecosystem.config.js --env production --update-env
else
    warn "   Приложение '${PM2_APP_NAME}' не найдено в PM2 — запускаем первый раз."
    pm2 start ecosystem.config.js --env production
fi

# ── 8. Сохранение конфигурации PM2 ──────────────────────────────────────────
step "8/8 pm2 save"
pm2 save

# ── Итог ─────────────────────────────────────────────────────────────────────
echo ""
step "Деплой завершён."
echo ""
echo "  Проверка здоровья:"
echo "    curl -s https://app.example.com/api/health"
echo ""
echo "  Логи приложения:"
echo "    pm2 logs ${PM2_APP_NAME} --lines 50"
echo ""
echo "  Статус PM2:"
echo "    pm2 status"
