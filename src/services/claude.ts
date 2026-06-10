import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';

/**
 * Низкоуровневый Anthropic Messages API клиент.
 *
 * - Singleton-инстанс на весь процесс.
 * - Retry: 3 попытки, экспоненциальная задержка 1s / 3s / 9s.
 *   При 429 (rate limit) — задержка 30s вместо штатной.
 * - Таймаут одного запроса: 30s. После исчерпания попыток → CLAUDE_API_TIMEOUT.
 * - Модель берётся из config.CLAUDE_MODEL (не хардкодим).
 * - Температура 0 (детерминированность классификации).
 * - В лог пишется только metadata: claude_request_id, tokens_used, latency_ms.
 *   Полный текст (system/messages/ответ) НЕ логируется.
 */

const log = childLogger({ handler: 'claude' });

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;
const RATE_LIMIT_DELAY_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1024;
const CACHE_TTL_MS = 1000 * 60 * 5; // 5 минут
const JSON_RETRY_HINT = 'ВАЖНО: верни ТОЛЬКО ВАЛИДНЫЙ JSON без какого-либо текста, пояснений или markdown-обёрток.';

const promptCache = new Map<
  string,
  { response: string; createdAt: number }
>();

const client = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  // Отключаем встроенный retry SDK — управляем повторами вручную (нужна
  // особая логика 429 → 30s и единый таймаут на попытку).
  maxRetries: 0,
});

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(z.record(z.unknown()))]),
});

const CallClaudeSchema = z.object({
  system: z.string(),
  messages: z.array(MessageSchema).min(1),
  expectJson: z.boolean().default(false),
  maxTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS),
  // Опциональные оверрайды. По умолчанию — поведение классификатора
  // (config.CLAUDE_MODEL, temperature 0). AI-наставник передаёт свою модель
  // (config.AI_MENTOR_MODEL) и температуру ~0.4 — ничего не ломая для классификатора.
  model: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
});

export type CallClaudeInput = z.input<typeof CallClaudeSchema>;
export type CallClaudeResult = string | Record<string, unknown>;

/** Ошибка вызова Claude с машиночитаемым кодом. */
export class ClaudeError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ClaudeError';
    this.code = code;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(err: unknown): boolean {
  return err instanceof Anthropic.APIError && err.status === 429;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // 429 и 5xx — временные. 4xx (кроме 429) — фатальные (например, 400/401).
    return err.status === 429 || err.status === undefined || err.status >= 500;
  }
  // Сетевые ошибки / таймауты SDK — APIConnectionError / APIConnectionTimeoutError.
  if (err instanceof Anthropic.APIConnectionError) return true;
  return false;
}

/** Достаёт request id из ответа SDK (поле _request_id). */
function extractRequestId(message: Anthropic.Message): string | null {
  const withId = message as Anthropic.Message & { _request_id?: string | null };
  return withId._request_id ?? null;
}

/** Склеивает текстовые блоки ответа в строку. */
function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Снимает markdown-обёртку ```json ... ``` (или просто ``` ... ```) и парсит JSON.
 * Если в строке есть лишний текст вокруг — пытается выделить первый JSON-объект.
 */
function parseJsonResponse(raw: string): Record<string, unknown> {
  let text = raw.trim();

  // Снять fenced-блок ```json ... ``` или ``` ... ```
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenceMatch?.[1] !== undefined) {
    text = fenceMatch[1].trim();
  }

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct !== null) return direct;

  // Фолбэк: выделить подстроку от первой { до последней }.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const sliced = tryParse(text.slice(first, last + 1));
    if (sliced !== null) return sliced;
  }

  throw new ClaudeError('CLAUDE_INVALID_JSON', 'Не удалось распарсить JSON из ответа Claude');
}

/** Один сетевой вызов Anthropic с таймаутом на запрос. */
async function createMessage(
  system: string,
  messages: Anthropic.MessageParam[],
  maxTokens: number,
  model: string,
  temperature: number
): Promise<Anthropic.Message> {
  return client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
}

/**
 * Выполняет вызов Claude с retry-логикой. Возвращает текст ответа.
 * При исчерпании попыток выбрасывает ClaudeError('CLAUDE_API_TIMEOUT').
 */
async function callWithRetry(
  system: string,
  messages: Anthropic.MessageParam[],
  maxTokens: number,
  model: string,
  temperature: number
): Promise<{ text: string; requestId: string | null; tokensUsed: number }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    try {
      const message = await createMessage(system, messages, maxTokens, model, temperature);
      const requestId = extractRequestId(message);
      const tokensUsed = message.usage.input_tokens + message.usage.output_tokens;

      log.info(
        {
          claude_request_id: requestId,
          tokens_used: tokensUsed,
          latency_ms: Date.now() - start,
          attempt: attempt + 1,
        },
        'claude_request_ok'
      );

      return { text: extractText(message), requestId, tokensUsed };
    } catch (err) {
      lastError = err;
      const status = err instanceof Anthropic.APIError ? err.status : undefined;

      log.warn(
        {
          latency_ms: Date.now() - start,
          attempt: attempt + 1,
          status,
          retryable: isRetryable(err),
        },
        'claude_request_failed'
      );

      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
      if (isLastAttempt || !isRetryable(err)) {
        break;
      }

      const delay = isRateLimit(err) ? RATE_LIMIT_DELAY_MS : RETRY_DELAYS_MS[attempt]!;
      await sleep(delay);
    }
  }

  throw new ClaudeError('CLAUDE_API_TIMEOUT', 'Anthropic API не ответил за отведённое число попыток', {
    cause: lastError,
  });
}

export async function callClaude(input: CallClaudeInput): Promise<CallClaudeResult> {
  const parsed = CallClaudeSchema.parse(input);
  const messages = parsed.messages as Anthropic.MessageParam[];

  // Дефолты сохраняют поведение классификатора, если оверрайды не переданы.
  const model = parsed.model ?? config.CLAUDE_MODEL;
  const temperature = parsed.temperature ?? 0;

  const cacheKey = JSON.stringify({
    system: parsed.system,
    messages: parsed.messages,
    maxTokens: parsed.maxTokens,
    expectJson: parsed.expectJson,
    model,
    temperature,
  });
  const cached = promptCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    if (!parsed.expectJson) {
      return cached.response;
    }
    try {
      return parseJsonResponse(cached.response);
    } catch {
      promptCache.delete(cacheKey);
    }
  }

  const result = await callWithRetry(parsed.system, messages, parsed.maxTokens, model, temperature);

  if (!parsed.expectJson) {
    promptCache.set(cacheKey, { response: result.text, createdAt: Date.now() });
    return result.text;
  }

  // Попытка №1: распарсить как есть.
  try {
    const parsedResponse = parseJsonResponse(result.text);
    promptCache.set(cacheKey, { response: result.text, createdAt: Date.now() });
    return parsedResponse;
  } catch {
    log.warn({ claude_request_id: result.requestId }, 'claude_json_parse_failed_retrying');
  }

  // Повтор с усиленным system-хинтом «ТОЛЬКО ВАЛИДНЫЙ JSON».
  const retried = await callWithRetry(
    `${parsed.system}\n\n${JSON_RETRY_HINT}`,
    messages,
    parsed.maxTokens,
    model,
    temperature
  );

  try {
    return parseJsonResponse(retried.text);
  } catch (err) {
    log.error({ claude_request_id: retried.requestId }, 'claude_json_parse_failed_final');
    throw new ClaudeError('CLAUDE_INVALID_JSON', 'Claude вернул невалидный JSON после повторной попытки', {
      cause: err,
    });
  }
}
