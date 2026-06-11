/**
 * POST /api/webapp/session
 *
 * Верификация Telegram initData, возврат профиля пользователя,
 * списка entities, availableDirections, defaultPeriod (текущий месяц), features.
 */

import { sql } from '../../db/client.js';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import { getCurrentMonthPeriod } from '../../utils/dates.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler } from '../http.js';

const log = childLogger({ handler: 'session' });

interface EntityRow {
  id: string;
  display_name: string;
}

interface DirectionRow {
  id: string;
  display_name: string;
}

export const sessionHandler: ApiHandler = async (req) => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    // Fetch entities (all)
    const entityRows = await sql<EntityRow[]>`
      SELECT id, display_name FROM entities ORDER BY created_at ASC
    `;

    // Fetch active directions
    const directionRows = await sql<DirectionRow[]>`
      SELECT id, display_name FROM directions
      WHERE is_active = true
      ORDER BY code ASC
    `;

    const period = getCurrentMonthPeriod();
    // Дефолтный период по умолчанию расширяем НАЗАД на прошлый месяц (с 1-го числа
    // прошлого месяца по сегодня), чтобы недавно загруженные операции прошлого
    // месяца сразу были видны на дашборде, а не только текущий (часто пустой) месяц.
    const fromDate = new Date(`${period.dateFrom}T00:00:00Z`);
    fromDate.setUTCMonth(fromDate.getUTCMonth() - 1);
    fromDate.setUTCDate(1);
    const defaultFrom = fromDate.toISOString().slice(0, 10);

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'session',
        latency_ms: Date.now() - start,
      },
      'webapp_session_ok'
    );

    return {
      status: 200,
      body: {
        user: {
          telegram_id: user.telegramId,
          name: user.fullName,
          role: user.role,
        },
        entities: entityRows.map((e) => ({ id: e.id, name: e.display_name })),
        availableDirections: directionRows.map((d) => ({ id: d.id, name: d.display_name })),
        defaultPeriod: { from: defaultFrom, to: period.dateTo },
        features: ['analytics', 'transactions', 'users'],
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) {
      return unauthorizedResponse(err.reason);
    }
    log.error({ err, handler: 'session', latency_ms: Date.now() - start }, 'webapp_session_error');
    throw err;
  }
};
