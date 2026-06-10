import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  redact: {
    paths: ['msg', '*.raw_input', '*.audio_base64'],
    remove: false,
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export function childLogger(context: {
  telegram_id?: bigint | number | string;
  handler?: string;
  [key: string]: unknown;
}) {
  const safe = { ...context };
  if (typeof safe['telegram_id'] === 'bigint') {
    safe['telegram_id'] = safe['telegram_id'].toString();
  }
  return logger.child(safe);
}

export function withLatency<T>(
  fn: () => Promise<T>,
  log: ReturnType<typeof logger.child>,
  label: string
): Promise<T> {
  const start = Date.now();
  return fn().finally(() => {
    log.info({ latency_ms: Date.now() - start }, label);
  });
}
