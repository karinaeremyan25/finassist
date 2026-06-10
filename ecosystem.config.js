// PM2 ecosystem config для FinAssist (Beget VPS, Ubuntu 22.04, Node 20 LTS).
//
// КАК PM2 ПОЛУЧАЕТ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ:
//   Node 20.6+ поддерживает флаг --env-file, поэтому мы передаём его через
//   `node_args`. PM2 запустит процесс как:
//     node --env-file=/etc/finassist/.env dist/index.js
//   Файл /etc/finassist/.env содержит все секреты (BOT_TOKEN, DATABASE_URL и т.д.)
//   и НЕ попадает в git. Создать на сервере:
//     sudo mkdir -p /etc/finassist
//     sudo cp .env.example /etc/finassist/.env
//     sudo nano /etc/finassist/.env   # заполнить значения
//     sudo chmod 600 /etc/finassist/.env
//     sudo chown <pm2-user>:<pm2-user> /etc/finassist/.env
//
//   Альтернатива (без --env-file): задать переменные через `env_production`
//   ниже ИЛИ через `pm2 set finassist:BOT_TOKEN ...` (хранится в ~/.pm2/).

module.exports = {
  apps: [
    {
      name: 'finassist',

      // Node 20.6+ --env-file загружает /etc/finassist/.env ДО старта процесса.
      // Убедитесь, что файл существует на сервере (см. setup-server.sh).
      script: 'dist/index.js',
      node_args: '--env-file=/etc/finassist/.env',

      // Один экземпляр обязателен: бот работает через long polling (не webhook),
      // несколько инстансов → дублирующиеся апдейты от Telegram.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,

      // Перезапуск при превышении 500 МБ RSS.
      max_memory_restart: '500M',

      // Exponential backoff при аварийных перезапусках (мс).
      exp_backoff_restart_delay: 100,

      // Логи — в ./logs/ (относительно рабочей директории проекта).
      // PM2 также дублирует их в ~/.pm2/logs/.
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,

      // Формат временных меток в логах PM2 (UTC ISO).
      log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSSZ',

      // Переменные окружения для режима production.
      // Секреты здесь НЕ указываем — они приходят из --env-file выше.
      // NODE_ENV здесь — страховка на случай, если .env файл не содержит его.
      env_production: {
        NODE_ENV: 'production',
      },

      // Для локальной разработки / CI (pm2 start --env development).
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
