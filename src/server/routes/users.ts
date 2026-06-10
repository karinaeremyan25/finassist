/**
 * GET /api/webapp/users
 *
 * Список активных пользователей с полем last_seen.
 */

import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import { getAllActiveUsersWithLastSeen } from '../../db/repositories/users.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler } from '../http.js';

const log = childLogger({ handler: 'webapp_users' });

export const usersHandler: ApiHandler = async (req) => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const users = await getAllActiveUsersWithLastSeen();

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'webapp_users',
        latency_ms: Date.now() - start,
      },
      'webapp_users_ok'
    );

    return {
      status: 200,
      body: {
        users: users.map((u) => ({
          telegram_id: u.telegramId,
          name: u.fullName,
          role: u.role,
          last_seen: u.lastSeen?.toISOString() ?? null,
        })),
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse();
    log.error(
      { err, handler: 'webapp_users', latency_ms: Date.now() - start },
      'webapp_users_error'
    );
    throw err;
  }
};
