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
