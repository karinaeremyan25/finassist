import { z } from 'zod';

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  OWNER_TG_ID: z.string().transform(s => BigInt(s)),
  ACCOUNTANT_TG_ID: z.string().transform(s => BigInt(s)),
  MANAGER_TG_ID: z
    .string()
    .optional()
    .transform(s =>
      s
        ? s
            .split(',')
            .map(id => id.trim())
            .filter(Boolean)
            .map(id => BigInt(id))
        : []
    ),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HEALTHCHECKS_URL: z.string().url().optional(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),
  // AI-наставник Mini App — качественный диалог, поэтому Opus (отдельно от
  // детерминированного классификатора на CLAUDE_MODEL). См. ai-agent-spec.md.
  AI_MENTOR_MODEL: z.string().default('claude-opus-4-8'),
  DEEPGRAM_API_KEY: z.string().optional(),
  // Mini App / Web App HTTP-сервер
  WEBAPP_PORT: z.coerce.number().int().positive().default(8080),
  // CSV список разрешённых Origin для CORS Mini App (пусто = same-origin).
  WEBAPP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform(s =>
      s
        ? s.split(',').map(o => o.trim()).filter(Boolean)
        : []
    ),
  // Публичный HTTPS-URL Mini App (нужен для web_app-кнопки Telegram).
  // Если не задан — кнопка /app деградирует до текстового предупреждения.
  WEBAPP_URL: z.string().url().optional(),
  // Путь до собранного фронтенда Mini App (Вариант B — раздача из Node).
  // В разработке: src/app/webapp/dist, в проде указать на реальный dist.
  WEBAPP_STATIC_DIR: z.string().default('src/app/webapp/dist'),

  // ── Интеграции: платёжные источники (optional, не логировать) ────────────
  // Robokassa: логин магазина и второй пароль (Password2 для подписи ResultURL).
  // ResultURL = https://<домен>/api/webhooks/robokassa
  ROBOKASSA_MERCHANT_LOGIN: z.string().optional(),
  ROBOKASSA_PASSWORD: z.string().optional(),
  // Prodamus: API-ключ (Bearer-токен, для возможных REST-запросов в будущем).
  // Webhook URL = https://<домен>/api/webhooks/prodamus
  PRODAMUS_API_KEY: z.string().optional(),
  // Prodamus: секретный ключ для HMAC-SHA256 подписи webhook (отдельный от API-ключа).
  // Настройки Prodamus → Уведомления → Секретный ключ.
  PRODAMUS_SECRET_KEY: z.string().optional(),
  // Lava.top: секрет для верификации подписи вебхука (HMAC-SHA256 над сырым телом,
  // заголовок `signature`). Личный кабинет Lava.top → Настройки API/вебхуков.
  // Если не задан — вебхук Lava отклоняется (400 bad sign).
  LAVA_WEBHOOK_SECRET: z.string().trim().optional(),
  // Точка Банк: OAuth 2.0 client_id и client_secret.
  TOCHKA_CLIENT_ID: z.string().optional(),
  TOCHKA_CLIENT_SECRET: z.string().optional(),
  // Точка Банк: redirect_uri для authorization_code flow.
  // Должен совпадать с Redirect URL, указанным при регистрации приложения в Точке.
  TOCHKA_REDIRECT_URI: z.string().url().default('https://finassist-virid.vercel.app/api/tochka/callback'),
  // Точка Банк: JWT Bearer-токен для прямого доступа к выпискам (без OAuth).
  // Используется синхронизатором POST /api/tochka/sync (tochkaSync.ts).
  // Если не задан — синхронизация вернёт ошибку «ключ Точки не настроен».
  // .trim() — подстраховка от случайных пробелов/переносов при вставке в Vercel.
  TOCHKA_JWT_TOKEN: z.string().trim().optional(),
  // Секрет для авторизации cron-вызовов (POST /api/tochka/sync).
  // Передаётся в заголовке: Authorization: Bearer <CRON_SECRET>.
  // Если не задан — cron-аутентификация отключена (принимаются только
  // запросы от пользователей Mini App через X-Telegram-Init-Data).
  CRON_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map(i => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${missing}\n${result.error.message}`);
  }
  return result.data;
}

export const config = loadConfig();
