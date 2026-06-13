/**
 * P&L route handlers (feature-spec-pnl.md):
 *
 *   GET  /api/analytics/pnl                   — P&L за месяц
 *   GET  /api/analytics/pnl/year              — годовой P&L помесячно
 *   GET  /api/analytics/personal-spending     — личные траты за месяц
 *   PATCH /api/analytics/transactions/category — исправить категорию транзакции
 *
 * Авторизация: resolveWebAppUser (Telegram initData, whitelist app_users).
 * Все роли (owner / accountant / manager) имеют одинаковый доступ.
 * Запросы к БД строго последовательно (pgBouncer transaction mode).
 * Суммы в копейках (bigint). bigintReplacer в http.ts конвертирует при сериализации.
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import {
  ENTITY_IDS,
  VALID_PNL_CATEGORIES,
  getPnlForPeriod,
  getYearPnl,
  getPersonalSpending,
  updateTxCategory,
  prevMonth,
  monthBoundaries,
} from '../../db/repositories/pnl.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'pnl' });

// ── Константы ──────────────────────────────────────────────────────────────

/** Человекочитаемые названия личных категорий. */
const PERSONAL_CATEGORY_LABELS: Record<string, string> = {
  personal_food: 'Еда и продукты',
  personal_shopping: 'Онлайн-шопинг',
  personal_fuel: 'Бензин',
  personal_restaurant: 'Рестораны',
  personal_entertainment: 'Развлечения',
  personal_coffee: 'Кофе',
  personal_other: 'Прочее личное',
};

// ── Схемы валидации ────────────────────────────────────────────────────────

const EntitySchema = z.enum(['ip', 'ooo', 'total']);

const PeriodSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Параметр period должен быть в формате YYYY-MM');

const YearSchema = z.coerce
  .number()
  .int()
  .min(2000)
  .max(2100);

const PnlQuerySchema = z.object({
  entity: EntitySchema,
  period: PeriodSchema,
});

const YearPnlQuerySchema = z.object({
  entity: EntitySchema,
  year: YearSchema,
});

const PersonalSpendingQuerySchema = z.object({
  period: PeriodSchema,
});

const UpdateCategoryBodySchema = z.object({
  id: z.string().uuid(),
  category: z.string().min(1),
});

// ── Хелперы ────────────────────────────────────────────────────────────────

/**
 * Маппинг entity code → массив entity_id или null (total = оба).
 */
function resolveEntityIds(entity: 'ip' | 'ooo' | 'total'): string[] | null {
  if (entity === 'ip') return [ENTITY_IDS.ip];
  if (entity === 'ooo') return [ENTITY_IDS.ooo];
  return null; // total = без фильтра
}

function invalidRequest(message: string): ApiResponse {
  return {
    status: 400,
    body: { error: { code: 'invalid_request', message } },
  };
}

// ── GET /api/analytics/pnl ────────────────────────────────────────────────

export const pnlHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = PnlQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.errors[0]?.message ?? 'Параметры entity и period обязательны'
      );
    }

    const { entity, period } = parsed.data;
    const entityIds = resolveEntityIds(entity);

    // Данные текущего периода
    const current = await getPnlForPeriod(period, entityIds);

    // Бизнес-расходы = сумма по категориям + налог
    const expensesSubtotal =
      current.expensesBreakdown.payroll +
      current.expensesBreakdown.marketing +
      current.expensesBreakdown.subscriptions +
      current.expensesBreakdown.loan +
      current.expensesBreakdown.payment_commission +
      current.expensesBreakdown.other_business;
    const expensesTotal = expensesSubtotal + current.tax;

    const profit = current.incomeTotal - expensesTotal;
    const margin_pct =
      current.incomeTotal === 0n
        ? 0
        : Math.round((Number(profit) / Number(current.incomeTotal)) * 1000) / 10;

    // Данные предыдущего месяца для сравнения
    const prev = prevMonth(period);
    const previous = await getPnlForPeriod(prev, entityIds);

    const prevExpensesSubtotal =
      previous.expensesBreakdown.payroll +
      previous.expensesBreakdown.marketing +
      previous.expensesBreakdown.subscriptions +
      previous.expensesBreakdown.loan +
      previous.expensesBreakdown.payment_commission +
      previous.expensesBreakdown.other_business;
    const prevExpensesTotal = prevExpensesSubtotal + previous.tax;
    const prevProfit = previous.incomeTotal - prevExpensesTotal;

    const incomeDeltaPct = calcDeltaPct(current.incomeTotal, previous.incomeTotal);
    const profitDeltaPct = calcDeltaPct(profit, prevProfit);

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'pnl',
        entity,
        period,
        latency_ms: Date.now() - start,
      },
      'pnl_ok'
    );

    return {
      status: 200,
      body: {
        entity,
        period,
        income: {
          total: current.incomeTotal,
          sources: current.incomeSources,
        },
        expenses: {
          total: expensesTotal,
          breakdown: {
            payroll: current.expensesBreakdown.payroll,
            marketing: current.expensesBreakdown.marketing,
            tax: current.tax,
            payment_commission: current.expensesBreakdown.payment_commission,
            subscriptions: current.expensesBreakdown.subscriptions,
            loan: current.expensesBreakdown.loan,
            other_business: current.expensesBreakdown.other_business,
          },
        },
        profit,
        margin_pct,
        vs_prev_month: {
          income_delta_pct: incomeDeltaPct,
          profit_delta_pct: profitDeltaPct,
        },
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'pnl', latency_ms: Date.now() - start }, 'pnl_error');
    throw err;
  }
};

// ── GET /api/analytics/pnl/year ───────────────────────────────────────────

export const pnlYearHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = YearPnlQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.errors[0]?.message ?? 'Параметры entity и year обязательны'
      );
    }

    const { entity, year } = parsed.data;
    const entityIds = resolveEntityIds(entity);

    const result = await getYearPnl(year, entityIds);

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'pnl_year',
        entity,
        year,
        latency_ms: Date.now() - start,
      },
      'pnl_year_ok'
    );

    return {
      status: 200,
      body: {
        entity,
        year,
        months: result.months,
        totals: result.totals,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'pnl_year', latency_ms: Date.now() - start }, 'pnl_year_error');
    throw err;
  }
};

// ── GET /api/analytics/personal-spending ──────────────────────────────────

export const personalSpendingHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = PersonalSpendingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.errors[0]?.message ?? 'Параметр period обязателен'
      );
    }

    const { period } = parsed.data;

    // Текущий период
    const current = await getPersonalSpending(period);

    // Предыдущий период для vs_prev_month_pct
    const prev = prevMonth(period);
    const previous = await getPersonalSpending(prev);

    const prevCategoryMap = new Map<string, bigint>();
    for (const c of previous.categories) {
      prevCategoryMap.set(c.code, c.amount);
    }

    const vs_prev_month_pct = calcDeltaPct(current.total, previous.total);

    const categories = current.categories
      .filter((c) => c.amount > 0n)
      .map((c) => {
        const prevAmt = prevCategoryMap.get(c.code) ?? 0n;
        const pct =
          current.total === 0n
            ? 0
            : Math.round((Number(c.amount) / Number(current.total)) * 1000) / 10;
        const catVsPrev = calcDeltaPct(c.amount, prevAmt);
        return {
          code: c.code,
          label: PERSONAL_CATEGORY_LABELS[c.code] ?? c.code,
          amount: c.amount,
          pct,
          vs_prev_month_pct: catVsPrev,
        };
      });

    // Добавляем категории с нулями (из предыдущего месяца, которых нет в текущем) — не нужно,
    // спека не требует; фильтруем только ненулевые текущего периода.

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'personal_spending',
        period,
        latency_ms: Date.now() - start,
      },
      'personal_spending_ok'
    );

    return {
      status: 200,
      body: {
        period,
        total: current.total,
        vs_prev_month_pct,
        categories,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error(
      { err, handler: 'personal_spending', latency_ms: Date.now() - start },
      'personal_spending_error'
    );
    throw err;
  }
};

// ── PATCH /api/analytics/transactions/category ────────────────────────────

export const updateTxCategoryHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = UpdateCategoryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.errors[0]?.message ?? 'Поля id (uuid) и category обязательны'
      );
    }

    const { id, category } = parsed.data;

    // Проверка допустимости категории
    if (!(VALID_PNL_CATEGORIES as readonly string[]).includes(category)) {
      return {
        status: 400,
        body: {
          error: {
            code: 'invalid_request',
            message: `Unknown category: ${category}`,
          },
        },
      };
    }

    const result = await updateTxCategory(id, category, user.id);

    if (result === null) {
      return {
        status: 404,
        body: { error: { code: 'not_found', message: 'Транзакция не найдена' } },
      };
    }

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'update_tx_category',
        tx_id: id,
        category,
        latency_ms: Date.now() - start,
      },
      'update_tx_category_ok'
    );

    return {
      status: 200,
      body: {
        id: result.id,
        category: result.pnl_category,
        needs_review: result.needs_review,
        category_overridden_at: result.category_overridden_at,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error(
      { err, handler: 'update_tx_category', latency_ms: Date.now() - start },
      'update_tx_category_error'
    );
    throw err;
  }
};

// ── Вспомогательная функция (не экспортируется) ────────────────────────────

function calcDeltaPct(current: bigint, previous: bigint): number | null {
  if (previous === 0n) return null;
  const raw = (Number(current - previous) / Number(previous)) * 100;
  return Math.round(raw * 10) / 10;
}

// Экспортируем monthBoundaries для возможного использования в тестах
export { monthBoundaries };
