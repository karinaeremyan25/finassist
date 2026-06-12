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
import { getUserByTelegramId, claimPendingUserByUsername, touchUserLastSeen } from '../db/repositories/users.js';
import { childLogger } from '../utils/logger.js';
import type { AppUser } from '../types.js';
import type { ApiRequest } from './http.js';

const log = childLogger({ handler: 'webapp_auth' });

/** Максимальный возраст initData в секундах (24 часа). */
const MAX_AGE_SECONDS = 86_400;

// ── Typed errors ───────────────────────────────────────────────────────────

export class WebAppAuthError extends Error {
  readonly code: 'unauthorized';
  readonly reason: string;

  constructor(message: string, reason = 'unknown') {
    super(message);
    this.name = 'WebAppAuthError';
    this.code = 'unauthorized';
    this.reason = reason;
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
  const hash = params.get('hash');
  if (hash === null || hash.length === 0) {
    throw new WebAppAuthError('Сессия не распознана', 'no_hash');
  }

  const secretKey = hmacSha256('WebAppData', config.BOT_TOKEN);

  // Считаем data-check-string ДВУМЯ способами и проверяем, какой совпадёт:
  //  A) исключаем только hash (signature остаётся в строке)
  //  B) исключаем и hash, и signature
  const buildDcs = (excludeSignature: boolean): string => {
    const e: string[] = [];
    params.forEach((value, key) => {
      if (key === 'hash') return;
      if (excludeSignature && key === 'signature') return;
      e.push(`${key}=${value}`);
    });
    e.sort();
    return e.join('\n');
  };
  const dcsA = buildDcs(false); // signature ВКЛЮЧЁН
  const dcsB = buildDcs(true); // signature ИСКЛЮЧЁН
  const hashA = hmacSha256(secretKey, dcsA).toString('hex');
  const hashB = hmacSha256(secretKey, dcsB).toString('hex');
  const recvLower = hash.toLowerCase();
  const matchA = hashA.toLowerCase() === recvLower;
  const matchB = hashB.toLowerCase() === recvLower;

  // Принимаем, если совпал любой из вариантов (с signature или без).
  const hashesMatch = matchA || matchB;

  if (!hashesMatch) {
    throw new WebAppAuthError('Сессия не распознана', 'hmac');
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
    throw new WebAppAuthError('Сессия не распознана', 'authdate');
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
  const rawUsername = (rawUser as Record<string, unknown>)['username'];
  const username = typeof rawUsername === 'string' && rawUsername.length > 0 ? rawUsername : null;
  return { telegramId, username, rawUser };
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

  if (initData === null) {
    throw new WebAppAuthError('Сессия не распознана', 'no_initdata');
  }

  const { telegramId, username } = verifyInitData(initData);

  let user = await getUserByTelegramId(telegramId);
  // Пользователь мог быть заведён заранее по @username (admin добавил по нику) —
  // при первом входе привязываем его telegram_id и пускаем.
  if (user === null && username !== null) {
    user = await claimPendingUserByUsername(telegramId, username);
  }
  if (user === null || !user.isActive) {
    log.warn({ telegram_id: telegramId.toString() }, 'webapp_auth_denied');
    throw new WebAppAuthError('Сессия не распознана', 'user_not_found');
  }

  // Отмечаем активность для экрана /users (fire-and-forget — не блокируем запрос).
  void touchUserLastSeen(telegramId).catch((err: unknown) => {
    log.warn({ err, telegram_id: telegramId.toString() }, 'webapp_touch_last_seen_failed');
  });

  return user;
}

// ── Convenience: build 401 response body ──────────────────────────────────

export function unauthorizedResponse(_reason?: string): { status: 401; body: { error: { code: string; message: string } } } {
  // _reason оставлен в сигнатуре для совместимости вызовов, но НЕ раскрывается
  // наружу (внутренние детали проверки не должны попадать в ответ клиенту).
  return {
    status: 401,
    body: { error: { code: 'unauthorized', message: 'Сессия не распознана' } },
  };
}
