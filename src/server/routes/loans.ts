/**
 * Кредиты: GET /api/loans?company=ip — расходы pnl_category='loan' по кредиторам.
 * Авторизация: resolveWebAppUser. Суммы — копейки (bigint).
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import { listLoans } from '../../db/repositories/loans.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'loans' });

const QuerySchema = z.object({ company: z.enum(['ip', 'ooo']).optional() });

export const loansListHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = QuerySchema.safeParse(req.query);
    const company = parsed.success ? parsed.data.company ?? null : null;

    const creditors = await listLoans(company);
    const total = creditors.reduce((s, c) => s + c.totalPaid, 0n);

    // Сумма за текущий месяц (МСК).
    const now = new Date();
    const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const ym = `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, '0')}`;
    let monthTotal = 0n;
    for (const c of creditors) {
      for (const p of c.payments) {
        if (p.occurredAt.slice(0, 7) === ym) monthTotal += p.amount;
      }
    }

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'loans_list', count: creditors.length, latency_ms: Date.now() - start },
      'loans_list_ok'
    );

    return {
      status: 200,
      body: {
        total,
        month_total: monthTotal,
        month: ym,
        data: creditors.map((c) => ({
          name: c.name,
          total_paid: c.totalPaid,
          count: c.count,
          first_date: c.firstDate,
          last_date: c.lastDate,
          payments: c.payments.map((p) => ({
            id: p.id,
            amount: p.amount,
            description: p.description,
            date: p.occurredAt,
            tochka_transaction_id: p.externalId,
          })),
        })),
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'loans_list', latency_ms: Date.now() - start }, 'loans_list_error');
    return { status: 200, body: { total: 0, data: [] } };
  }
};
