import { sql } from '../client.js';
import { mapAppUser, type AppUserRow } from './_mappers.js';
import type { AppUser, Role } from '../../types.js';

/**
 * Репозиторий пользователей (whitelist).
 *
 * getUserByTelegramId — основа auth-middleware: единственная проверка доступа.
 * Роли хранятся для аудита, но не ограничивают доступ к данным.
 */

/** Данные для создания пользователя. */
export interface CreateUserData {
  telegramId: bigint;
  fullName: string;
  role: Role;
  isActive?: boolean;
}

const SELECT_COLUMNS = sql`id, telegram_id, full_name, role, is_active`;

export async function getUserByTelegramId(telegramId: bigint): Promise<AppUser | null> {
  const rows = await sql<AppUserRow[]>`
    SELECT ${SELECT_COLUMNS}
    FROM app_users
    WHERE telegram_id = ${telegramId} AND is_active = true
  `;
  const row = rows[0];
  return row === undefined ? null : mapAppUser(row);
}

/**
 * Привязывает telegram_id к пользователю, заведённому заранее по @username
 * (admin добавил по нику, telegram_id ещё не известен). Вызывается при первом
 * входе: матчим по username (без учёта регистра), проставляем telegram_id.
 * Возвращает пользователя, если нашёлся pending-матч, иначе null.
 */
export async function claimPendingUserByUsername(
  telegramId: bigint,
  username: string
): Promise<AppUser | null> {
  const rows = await sql<AppUserRow[]>`
    UPDATE app_users
    SET telegram_id = ${telegramId}
    WHERE lower(username) = lower(${username})
      AND telegram_id IS NULL
      AND is_active = true
      AND deleted_at IS NULL
    RETURNING id, telegram_id, COALESCE(full_name, '@' || username, '') AS full_name, role, is_active
  `;
  const row = rows[0];
  return row === undefined ? null : mapAppUser(row);
}

export async function getAllActiveUsers(): Promise<AppUser[]> {
  const rows = await sql<AppUserRow[]>`
    SELECT ${SELECT_COLUMNS}
    FROM app_users
    WHERE is_active = true
    ORDER BY created_at ASC
  `;
  return rows.map(mapAppUser);
}

/** direction UUID'ы, доступные менеджеру. Owner/accountant — без записей. */
export async function getUserManagerDirections(userId: string): Promise<string[]> {
  const rows = await sql<{ direction_id: string }[]>`
    SELECT direction_id
    FROM manager_directions
    WHERE user_id = ${userId}
  `;
  return rows.map((r) => r.direction_id);
}

export async function createUser(data: CreateUserData): Promise<AppUser> {
  const rows = await sql<AppUserRow[]>`
    INSERT INTO app_users (telegram_id, full_name, role, is_active)
    VALUES (${data.telegramId}, ${data.fullName}, ${data.role}, ${data.isActive ?? true})
    RETURNING ${SELECT_COLUMNS}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error('createUser: INSERT did not return a row');
  }
  return mapAppUser(row);
}

export interface AppUserWithLastSeen {
  telegramId: bigint;
  fullName: string;
  role: string;
  lastSeen: Date | null;
}

/** Все активные пользователи с полем last_seen для экрана Mini App /users. */
export async function getAllActiveUsersWithLastSeen(): Promise<AppUserWithLastSeen[]> {
  const rows = await sql<{
    telegram_id: bigint;
    full_name: string;
    role: string;
    last_seen: Date | null;
  }[]>`
    SELECT telegram_id, full_name, role, last_seen
    FROM app_users
    WHERE is_active = true
    ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    telegramId: r.telegram_id,
    fullName: r.full_name,
    role: r.role,
    lastSeen: r.last_seen,
  }));
}

/** Отмечает последнюю активность пользователя в Mini App (last_seen = NOW()). */
export async function touchUserLastSeen(telegramId: bigint): Promise<void> {
  await sql`
    UPDATE app_users
    SET last_seen = NOW()
    WHERE telegram_id = ${telegramId} AND is_active = true
  `;
}

export async function setUserActive(userId: string, isActive: boolean): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    UPDATE app_users
    SET is_active = ${isActive}
    WHERE id = ${userId}
    RETURNING id
  `;
  if (rows[0] === undefined) {
    throw new Error(`setUserActive: user ${userId} not found`);
  }
}
