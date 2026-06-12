/**
 * /api/analytics/plan — план/факт по месяцу.
 *
 * GET  ?month=YYYY-MM  (по умолчанию — текущий месяц МСК, UTC+3)
 *   Читает monthly_plans + считает фактические суммы из transactions.
 *   Доступен всем ролям.
 *
 * POST  (только owner) — установить/обновить план на месяц.
 *   body: { month: 'YYYY-MM', income?: { min?, avg?, max? }, expense?: { min?, avg?, max? } }
 *   Суммы в копейках (bigint передаётся как number от фронта, конвертируем).
 *
 * Ответ GET:
 * {
 *   yearMonth: string,        // 'YYYY-MM'
 *   income: {
 *     min: number | null,     // копейки
 *     avg: number | null,
 *     max: number | null,
 *     actual: number,
 *     pctOfMin: number | null // actual/min*100, 1 знак, null если min=0 или null
 *   },
 *   expense: {
 *     min: number | null,
 *     avg: number | null,
 *     max: number | null,
 *     actual: number,
 *     pctOfMin: number | null
 *   }
 * }
 *
 * Все запросы к БД строго последовательны (pgBouncer transaction mode).
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import { getMonthlyPlan, getMonthActuals, upsertMonthlyPlan } from '../../db/repositories/plans.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'plan' });

// ── Схемы ─────────────────────────────────────────────────────────────────

const MonthParamSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Параметр month должен быть в формате YYYY-MM');

// Для POST: суммы приходят от фронта как number (bigint replacer → number)
const PlanAmountGroupSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  avg: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
});

const PostBodySchema = z.object({
  month: MonthParamSchema,
  income: PlanAmountGroupSchema.optional(),
  expense: PlanAmountGroupSchema.optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Текущий месяц в МСК (UTC+3) → 'YYYY-MM'.
 */
function currentMonthMsk(): string {
  const nowUtc = new Date();
  // +3 часа в мс
  const mskMs = nowUtc.getTime() + 3 * 60 * 60 * 1000;
  const msk = new Date(mskMs);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Преобразует 'YYYY-MM' → границы периода (UTC timestamptz-совместимые строки).
 * dateFrom  = 'YYYY-MM-01'           (включительно, >= dateFrom)
 * dateNext  = следующий месяц '01'   (исключительно, < dateNext)
 */
function monthBoundaries(yearMonth: string): { dateFrom: string; dateNext: string } {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10); // 1-12

  const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;

  // Следующий месяц
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear = year + 1;
  }
  const dateNext = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  return { dateFrom, dateNext };
}

/**
 * Вычисляет pctOfMin: actual / min * 100, округлённое до 1 знака.
 * null если min равен null, 0 или не задан.
 */
function calcPctOfMin(actual: bigint, min: bigint | null): number | null {
  if (min === null || min === 0n) return null;
  // Считаем в целых числах: (actual * 1000 / min) / 10 → 1 знак
  const raw = Number((actual * 1000n) / min) / 10;
  return Math.round(raw * 10) / 10;
}

// ── Обработчик ────────────────────────────────────────────────────────────

export const planHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    // ── GET ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rawMonth = req.query['month'] ?? currentMonthMsk();

      const monthParsed = MonthParamSchema.safeParse(rawMonth);
      if (!monthParsed.success) {
        return {
          status: 400,
          body: {
            error: {
              code: 'validation_error',
              message: monthParsed.error.errors[0]?.message ?? 'Неверный формат месяца',
            },
          },
        };
      }

      const yearMonth = monthParsed.data;
      const { dateFrom, dateNext } = monthBoundaries(yearMonth);

      // Запросы строго последовательно
      const plan = await getMonthlyPlan(yearMonth);
      const actuals = await getMonthActuals(dateFrom, dateNext);

      const incomeActual = actuals.incomeActual;
      const expenseActual = actuals.expenseActual;

      const incomeMin = plan?.incomeMin ?? null;
      const incomeAvg = plan?.incomeAvg ?? null;
      const incomeMax = plan?.incomeMax ?? null;
      const expenseMin = plan?.expenseMin ?? null;
      const expenseAvg = plan?.expenseAvg ?? null;
      const expenseMax = plan?.expenseMax ?? null;

      log.info(
        {
          telegram_id: user.telegramId.toString(),
          handler: 'plan_get',
          year_month: yearMonth,
          latency_ms: Date.now() - start,
        },
        'plan_get_ok'
      );

      return {
        status: 200,
        body: {
          yearMonth,
          income: {
            min: incomeMin,
            avg: incomeAvg,
            max: incomeMax,
            actual: incomeActual,
            pctOfMin: calcPctOfMin(incomeActual, incomeMin),
          },
          expense: {
            min: expenseMin,
            avg: expenseAvg,
            max: expenseMax,
            actual: expenseActual,
            pctOfMin: calcPctOfMin(expenseActual, expenseMin),
          },
        },
      };
    }

    // ── POST ──────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (user.role !== 'owner') {
        return {
          status: 403,
          body: {
            error: {
              code: 'forbidden',
              message: 'Установка плана доступна только владельцу',
            },
          },
        };
      }

      const parsed = PostBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return {
          status: 400,
          body: {
            error: {
              code: 'validation_error',
              message: parsed.error.errors[0]?.message ?? 'Невалидные данные',
            },
          },
        };
      }

      const { month, income, expense } = parsed.data;

      const updated = await upsertMonthlyPlan({
        yearMonth: month,
        incomeMin:  income?.min  !== undefined ? BigInt(income.min)  : undefined,
        incomeAvg:  income?.avg  !== undefined ? BigInt(income.avg)  : undefined,
        incomeMax:  income?.max  !== undefined ? BigInt(income.max)  : undefined,
        expenseMin: expense?.min !== undefined ? BigInt(expense.min) : undefined,
        expenseAvg: expense?.avg !== undefined ? BigInt(expense.avg) : undefined,
        expenseMax: expense?.max !== undefined ? BigInt(expense.max) : undefined,
      });

      log.info(
        {
          telegram_id: user.telegramId.toString(),
          handler: 'plan_post',
          year_month: month,
          latency_ms: Date.now() - start,
        },
        'plan_post_ok'
      );

      return {
        status: 200,
        body: {
          yearMonth: updated.yearMonth,
          income: {
            min: updated.incomeMin,
            avg: updated.incomeAvg,
            max: updated.incomeMax,
          },
          expense: {
            min: updated.expenseMin,
            avg: updated.expenseAvg,
            max: updated.expenseMax,
          },
        },
      };
    }

    return {
      status: 405,
      body: { error: { code: 'method_not_allowed', message: 'Метод не поддерживается' } },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);

    log.error(
      { err, handler: 'plan', latency_ms: Date.now() - start },
      'plan_error'
    );
    throw err;
  }
};
