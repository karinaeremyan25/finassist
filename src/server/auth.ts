/**
 * Telegram Mini App / Web App — серверная верификация initData.
 *
 * Алгоритм (официальная документация Telegram):
 *   1. Разбить initData на пары ключ=значение, отсортировать по ключу.
 *   2. Извлечь поле `hash` — это MAC, который нужно проверить.
 *   3. Построить data-check-string из остальных пар (key=value, \n-разделённые).
 *   4. secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN)
 *   5. expected_hash = HMAC-SHA256(secret_key, data-check-string)
 *   6. Сравнить expected_hash с полученным hash (constant-time).
 *   7. Проверить свежесть auth_date (не старше MAX_AGE_SECONDS).
 *   8. Распарсить user JSON, проверить telegram_id в app_users.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getUserByTelegramId, touchUserLastSeen } from '../db/repositories/users.js';
import { childLogger } from '../utils/logger.js';
import type { AppUser } from '../types.js';
import type { ApiRequest } from './http.js';

const log = childLogger({ handler: 'webapp_auth' });

/** Максимальный возраст initData в секундах (24 часа). */
const MAX_AGE_SECONDS = 86_400;

// ── Typed errors ───────────────────────────────────────────────────────────

export class WebAppAuthError extends Error {
  readonly code: 'unauthorized';

  constructor(message: string) {
    super(message);
    this.name = 'WebAppAuthError';
    this.code = 'unauthorized';
  }
}

// ── Low-level HMAC helpers ─────────────────────────────────────────────────

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf-8').digest();
}

// ── verifyInitData ─────────────────────────────────────────────────────────

/**
 * Проверяет подпись initData и свежесть auth_date.
 * Возвращает telegram_id пользователя или бросает WebAppAuthError.
 */
export function verifyInitData(initData: string): { telegramId: bigint; rawUser: unknown } {
  if (initData.trim().length === 0) {
    throw new WebAppAuthError('Сессия не распознана');
  }

  // Разбиваем на пары
  const params = new URLSearchParams(initData);
  const keyList = [...params.keys()].sort().join(',');
  const hash = params.get('hash');
  if (hash === null || hash.length === 0) {
    console.error(`[AUTHDBG] no_hash len=${initData.length} keys=${keyList}`);
    throw new WebAppAuthError('Сессия не распознана');
  }

  // Строим data-check-string: все пары КРОМЕ hash и signature, отсортированные по ключу.
  // ВАЖНО: современный Telegram добавляет поле `signature` (для альтернативной
  // Ed25519-проверки). Его, как и `hash`, нужно исключать при сверке по bot-token,
  // иначе HMAC не сойдётся и валидный пользователь получит 401.
  const entries: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash' && key !== 'signature') {
      entries.push(`${key}=${value}`);
    }
  });
  entries.sort();
  const dataCheckString = entries.join('\n');

  // Вычисляем ожидаемый хеш
  const secretKey = hmacSha256('WebAppData', config.BOT_TOKEN);
  const expectedHashBuf = hmacSha256(secretKey, dataCheckString);
  const expectedHex = expectedHashBuf.toString('hex');

  // Constant-time compare
  let hashesMatch = false;
  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const receivedBuf = Buffer.from(hash, 'hex');
    hashesMatch =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    hashesMatch = false;
  }

  if (!hashesMatch) {
    console.error(`[AUTHDBG] hmac_mismatch keys=${keyList} dcsLen=${dataCheckString.length} expLen=${expectedHex.length} gotLen=${hash.length} tokenLen=${config.BOT_TOKEN.length}`);
    throw new WebAppAuthError('Сессия не распознана');
  }

  // Проверка свежести
  const authDateStr = params.get('auth_date');
  if (authDateStr === null) {
    throw new WebAppAuthError('Сессия не распознана');
  }
  const authDate = parseInt(authDateStr, 10);
  if (isNaN(authDate)) {
    throw new WebAppAuthError('Сессия не распознана');
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  // Отвергаем и протухшие, и выписанные «из будущего» (auth_date вперёд) —
  // иначе при утечке токена можно было бы выпустить вечную сессию.
  const CLOCK_SKEW_SECONDS = 300;
  if (ageSeconds > MAX_AGE_SECONDS || ageSeconds < -CLOCK_SKEW_SECONDS) {
    console.error(`[AUTHDBG] authdate_out_of_range age=${ageSeconds}`);
    throw new WebAppAuthError('Сессия не распознана');
  }

  // Парсим user
  const userStr = params.get('user');
  if (userStr === null) {
    throw new WebAppAuthError('Сессия не распознана');
  }
  let rawUser: unknown;
  try {
    rawUser = JSON.parse(userStr) as unknown;
  } catch {
    throw new WebAppAuthError('Сессия не распознана');
  }

  if (
    typeof rawUser !== 'object' ||
    rawUser === null ||
    !('id' in rawUser) ||
    typeof (rawUser as Record<string, unknown>)['id'] !== 'number'
  ) {
    throw new WebAppAuthError('Сессия не распознана');
  }

  const telegramId = BigInt((rawUser as Record<string, unknown>)['id'] as number);
  return { telegramId, rawUser };
}

// ── resolveWebAppUser ──────────────────────────────────────────────────────

/**
 * Верифицирует initData (из заголовка X-Telegram-Init-Data или тела),
 * затем проверяет telegram_id в app_users.
 * Возвращает AppUser или бросает WebAppAuthError.
 */
export async function resolveWebAppUser(req: ApiRequest): Promise<AppUser> {
  // initData может прийти из заголовка ИЛИ из тела (для POST /api/webapp/session)
  let initData: string | null = null;

  const headerVal = req.rawReq.headers['x-telegram-init-data'];
  if (typeof headerVal === 'string' && headerVal.length > 0) {
    initData = headerVal;
  } else if (
    req.body !== null &&
    req.body !== undefined &&
    typeof req.body === 'object' &&
    'initData' in (req.body as Record<string, unknown>)
  ) {
    const bodyInitData = (req.body as Record<string, unknown>)['initData'];
    if (typeof bodyInitData === 'string' && bodyInitData.length > 0) {
      initData = bodyInitData;
    }
  }

  const hdrDbg = req.rawReq.headers['x-telegram-init-data'];
  console.error(`[AUTHDBG] header_present=${typeof hdrDbg === 'string'} header_len=${typeof hdrDbg === 'string' ? hdrDbg.length : 0} resolved=${initData !== null}`);

  if (initData === null) {
    console.error('[AUTHDBG] no_initData_source');
    throw new WebAppAuthError('Сессия не распознана');
  }

  const { telegramId } = verifyInitData(initData);

  const user = await getUserByTelegramId(telegramId);
  if (user === null || !user.isActive) {
    console.error(`[AUTHDBG] user_not_found_or_inactive tg=${telegramId.toString()}`);
    log.warn({ telegram_id: telegramId.toString() }, 'webapp_auth_denied');
    throw new WebAppAuthError('Сессия не распознана');
  }
  console.error(`[AUTHDBG] auth_ok tg=${telegramId.toString()}`);

  // Отмечаем активность для экрана /users (fire-and-forget — не блокируем запрос).
  void touchUserLastSeen(telegramId).catch((err: unknown) => {
    log.warn({ err, telegram_id: telegramId.toString() }, 'webapp_touch_last_seen_failed');
  });

  return user;
}

// ── Convenience: build 401 response body ──────────────────────────────────

export function unauthorizedResponse(): { status: 401; body: { error: { code: string; message: string } } } {
  return {
    status: 401,
    body: { error: { code: 'unauthorized', message: 'Сессия не распознана' } },
  };
}
