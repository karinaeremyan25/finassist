#!/usr/bin/env bash
# deploy/setup-server.sh — ОДНОРАЗОВАЯ настройка чистого Beget VPS.
#
# Запускать под sudo от имени root или через sudo bash:
#   sudo bash deploy/setup-server.sh
#
# После выполнения этого скрипта:
#   1. Заполните /etc/finassist/.env реальными значениями.
#   2. Замените app.example.com в /etc/nginx/sites-available/finassist на домен.
#   3. Выпустите TLS-сертификат: sudo certbot --nginx -d <ваш-домен>
#   4. Запустите deploy/deploy.sh для первого деплоя.
#
# Скрипт идемпотентен: повторный запуск безопасен (already-installed → skip).

set -euo pipefail

# ── Цвета ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step()  { echo -e "${GREEN}[SETUP]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }

# ── Проверка: запуск под root ─────────────────────────────────────────────────
if [[ "${EUID}" -ne 0 ]]; then
    echo "Запускать под sudo: sudo bash deploy/setup-server.sh"
    exit 1
fi

# ── Параметры (при необходимости изменить до запуска) ─────────────────────────
APP_USER="${SUDO_USER:-ubuntu}"          # пользователь, от имени которого PM2
APP_DIR="/opt/finassist"                 # корень проекта
WEBAPP_STATIC_DIR="/var/www/finassist-webapp"
ENV_DIR="/etc/finassist"
DOMAIN="app.example.com"                 # ЗАМЕНИТЬ на реальный домен

step "Параметры: APP_USER=${APP_USER}, DOMAIN=${DOMAIN}"

# ── 1. Обновление пакетов ─────────────────────────────────────────────────────
step "1. apt-get update && upgrade"
apt-get update -qq
apt-get upgrade -y -qq

# ── 2. Установка Node.js 20 LTS ──────────────────────────────────────────────
step "2. Node.js 20 LTS"
if command -v node &>/dev/null && node --version | grep -q '^v20\.'; then
    warn "   Node.js $(node --version) уже установлен — пропускаем."
else
    # Официальный способ от NodeSource
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    step "   Node.js $(node --version) установлен."
fi

# ── 3. Установка nginx ────────────────────────────────────────────────────────
step "3. nginx"
if dpkg -l nginx &>/dev/null; then
    warn "   nginx уже установлен — пропускаем."
else
    apt-get install -y nginx
    systemctl enable nginx
    systemctl start nginx
    step "   nginx установлен и запущен."
fi

# ── 4. Установка certbot ──────────────────────────────────────────────────────
step "4. certbot + python3-certbot-nginx"
if command -v certbot &>/dev/null; then
    warn "   certbot уже установлен — пропускаем."
else
    apt-get install -y certbot python3-certbot-nginx
    step "   certbot установлен."
fi
# Certbot при установке автоматически создаёт systemd-timer certbot.timer
# (или cron-задачу в /etc/cron.d/certbot), которая дважды в сутки запускает
# 'certbot renew'. Ручная настройка не нужна.
step "   Авто-renewal TLS: проверить командой 'systemctl status certbot.timer'"

# ── 5. Установка PM2 глобально ────────────────────────────────────────────────
step "5. PM2 global"
if command -v pm2 &>/dev/null; then
    warn "   PM2 $(pm2 --version) уже установлен — обновляем."
    npm install -g pm2@latest --quiet
else
    npm install -g pm2 --quiet
    step "   PM2 $(pm2 --version) установлен."
fi

# ── 6. PM2 startup (автозапуск при ребуте) ────────────────────────────────────
step "6. PM2 startup (автозапуск при ребуте)"
# Генерируем команду startup для текущего пользователя-владельца PM2.
# Выполняем её сразу — она добавляет systemd-unit pm2-<user>.service.
env HOME="/home/${APP_USER}" su -c "pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER}" - "${APP_USER}" || \
    warn "   pm2 startup завершился с ошибкой (возможно, уже настроен)."
systemctl enable "pm2-${APP_USER}" 2>/dev/null || true

# ── 7. Директория для статики Mini App ───────────────────────────────────────
step "7. Директория статики ${WEBAPP_STATIC_DIR}"
mkdir -p "${WEBAPP_STATIC_DIR}"
chown "${APP_USER}:www-data" "${WEBAPP_STATIC_DIR}"
chmod 755 "${WEBAPP_STATIC_DIR}"
step "   Создана: ${WEBAPP_STATIC_DIR}"

# ── 8. Директория uploads ─────────────────────────────────────────────────────
step "8. /uploads/unparsed"
mkdir -p /uploads/unparsed
chown "${APP_USER}:${APP_USER}" /uploads
chown "${APP_USER}:${APP_USER}" /uploads/unparsed
chmod 755 /uploads /uploads/unparsed
step "   Создана: /uploads/unparsed"

# ── 9. Env-файл ───────────────────────────────────────────────────────────────
step "9. Env-файл ${ENV_DIR}/.env"
mkdir -p "${ENV_DIR}"
if [[ -f "${ENV_DIR}/.env" ]]; then
    warn "   ${ENV_DIR}/.env уже существует — НЕ перезаписываем."
else
    # Копируем .env.example если он есть рядом со скриптом, иначе создаём пустой.
    EXAMPLE_FILE="$(dirname "$0")/../.env.example"
    if [[ -f "${EXAMPLE_FILE}" ]]; then
        cp "${EXAMPLE_FILE}" "${ENV_DIR}/.env"
        step "   Скопирован из .env.example. Заполните значения:"
    else
        touch "${ENV_DIR}/.env"
        step "   Создан пустой файл. Заполните значения:"
    fi
    echo "     sudo nano ${ENV_DIR}/.env"
fi
chown "${APP_USER}:${APP_USER}" "${ENV_DIR}/.env"
chmod 600 "${ENV_DIR}/.env"  # только владелец читает (секреты!)

# ── 10. nginx конфиг FinAssist ────────────────────────────────────────────────
step "10. nginx site config"
NGINX_CONF_SRC="$(dirname "$0")/nginx.conf"
NGINX_CONF_DST="/etc/nginx/sites-available/finassist"

if [[ -f "${NGINX_CONF_DST}" ]]; then
    warn "    ${NGINX_CONF_DST} уже существует — НЕ перезаписываем."
    warn "    Чтобы обновить: sudo cp deploy/nginx.conf /etc/nginx/sites-available/finassist"
else
    if [[ -f "${NGINX_CONF_SRC}" ]]; then
        cp "${NGINX_CONF_SRC}" "${NGINX_CONF_DST}"
        step "    Скопирован в ${NGINX_CONF_DST}"
    else
        warn "    deploy/nginx.conf не найден — скопируйте вручную."
    fi
fi

# Активируем сайт
NGINX_LINK="/etc/nginx/sites-enabled/finassist"
if [[ ! -L "${NGINX_LINK}" ]]; then
    ln -s "${NGINX_CONF_DST}" "${NGINX_LINK}"
    step "    Символическая ссылка создана: ${NGINX_LINK}"
fi

# Отключаем дефолтный сайт nginx (занимает порт 80 и мешает certbot)
if [[ -L "/etc/nginx/sites-enabled/default" ]]; then
    rm /etc/nginx/sites-enabled/default
    warn "    Дефолтный сайт nginx отключён."
fi

# Проверяем конфиг nginx
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    step "    nginx перезагружен."
else
    warn "    nginx -t завершился с ошибками. Проверьте конфиг вручную: sudo nginx -t"
fi

# ── 11. Выпуск TLS-сертификата ────────────────────────────────────────────────
step "11. TLS-сертификат Let's Encrypt"
echo ""
echo "  ВНИМАНИЕ: перед выпуском сертификата убедитесь, что:"
echo "    a) DNS-запись A для ${DOMAIN} указывает на IP этого сервера"
echo "    b) Порт 80 открыт (проверить: curl http://${DOMAIN}/)"
echo ""
echo "  Выпустить сертификат вручную после выполнения этого скрипта:"
echo ""
echo "    sudo certbot --nginx -d ${DOMAIN}"
echo ""
echo "  Certbot автоматически:"
echo "    - получит сертификат в /etc/letsencrypt/live/${DOMAIN}/"
echo "    - обновит /etc/nginx/sites-available/finassist (добавит ssl_certificate)"
echo "    - настроит авто-renewal через systemd-timer certbot.timer"
echo ""

# Автоматический запуск certbot только если домен уже не example.com
# и DNS уже настроен (определяем по резолвингу).
if [[ "${DOMAIN}" != "app.example.com" ]]; then
    if host "${DOMAIN}" &>/dev/null; then
        warn "   Запускаем certbot автоматически..."
        certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos \
            --email "admin@${DOMAIN}" || warn "certbot завершился с ошибкой — проверьте вручную."
    else
        warn "   DNS для ${DOMAIN} не резолвится — пропускаем certbot. Запустите вручную."
    fi
else
    warn "   DOMAIN=app.example.com (плейсхолдер) — certbot НЕ запускаем автоматически."
fi

# ── 12. Клонирование проекта ─────────────────────────────────────────────────
step "12. Директория проекта ${APP_DIR}"
if [[ -d "${APP_DIR}" ]]; then
    warn "    ${APP_DIR} уже существует — пропускаем клонирование."
else
    step "    Создаём ${APP_DIR} (клонируйте репозиторий вручную):"
    echo "      sudo mkdir -p ${APP_DIR}"
    echo "      sudo chown ${APP_USER}:${APP_USER} ${APP_DIR}"
    echo "      cd ${APP_DIR} && git clone <repo_url> ."
fi

# ── Финальный чеклист ─────────────────────────────────────────────────────────
echo ""
step "Настройка завершена. Чеклист перед первым деплоем:"
echo ""
echo "  [ ] 1. Заполнить ${ENV_DIR}/.env (BOT_TOKEN, DATABASE_URL, ANTHROPIC_API_KEY, ...)"
echo "  [ ] 2. Заменить app.example.com → реальный домен в /etc/nginx/sites-available/finassist"
echo "  [ ] 3. Убедиться, что DNS A-запись настроена"
echo "  [ ] 4. Выпустить TLS: sudo certbot --nginx -d <домен>"
echo "  [ ] 5. Клонировать репо в ${APP_DIR}"
echo "  [ ] 6. cd ${APP_DIR} && bash deploy/deploy.sh"
echo "  [ ] 7. curl https://<домен>/api/health  → {\"status\":\"ok\"}"
echo ""
