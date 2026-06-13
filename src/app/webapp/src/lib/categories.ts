/**
 * Метаданные категорий P&L: цвета личных трат, ярлыки и порядок
 * бизнес-расходов. Цвета — из feature-spec-pnl.md.
 */

/** Цвета личных категорий (точка + прогресс-бар). Прочее/неизвестное — серый. */
const PERSONAL_COLORS: Record<string, string> = {
  personal_food: '#534AB7',
  personal_shopping: '#D85A30',
  personal_fuel: '#BA7517',
  personal_restaurant: '#1D9E75',
  personal_entertainment: '#378ADD',
  personal_coffee: '#888780',
  personal_other: '#5E827C',
};

const PERSONAL_FALLBACK = '#5E827C';

export function personalColor(code: string): string {
  return PERSONAL_COLORS[code] ?? PERSONAL_FALLBACK;
}

/** Бизнес-расходы: порядок строк и человекочитаемые ярлыки. */
export const BUSINESS_EXPENSE_ROWS: Array<{
  key:
    | 'payroll'
    | 'marketing'
    | 'tax'
    | 'subscriptions'
    | 'loan'
    | 'payment_commission'
    | 'other_business';
  label: string;
}> = [
  { key: 'payroll', label: 'ФОТ' },
  { key: 'marketing', label: 'Маркетинг' },
  { key: 'tax', label: 'Налог' },
  { key: 'subscriptions', label: 'Подписки' },
  { key: 'loan', label: 'Кредиты' },
  { key: 'payment_commission', label: 'Комиссии' },
  { key: 'other_business', label: 'Прочее' },
];

/** Источники дохода: порядок и ярлыки. */
export const INCOME_SOURCE_ROWS: Array<{
  key: 'prodamus' | 'robokassa' | 'tochka_direct';
  label: string;
}> = [
  { key: 'prodamus', label: 'Продамус' },
  { key: 'robokassa', label: 'Робокасса' },
  { key: 'tochka_direct', label: 'Точка напрямую' },
];

// ── Варианты смены категории операции ──────────────────────────────────────
// Коды СТРОГО совпадают с VALID_PNL_CATEGORIES на бэке
// (src/db/repositories/pnl.ts → PATCH /api/analytics/transactions/category).

export interface CategoryOption {
  code: string;
  label: string;
}

export const BUSINESS_CATEGORY_OPTIONS: CategoryOption[] = [
  { code: 'payroll', label: 'ФОТ/Зарплата' },
  { code: 'marketing', label: 'Маркетинг' },
  { code: 'loan', label: 'Кредиты' },
  { code: 'subscriptions', label: 'Подписки/сервисы' },
  { code: 'tax', label: 'Налог' },
  { code: 'other_business', label: 'Прочее (бизнес)' },
];

export const PERSONAL_CATEGORY_OPTIONS: CategoryOption[] = [
  { code: 'personal_food', label: 'Еда' },
  { code: 'personal_shopping', label: 'Шопинг' },
  { code: 'personal_fuel', label: 'Бензин' },
  { code: 'personal_restaurant', label: 'Рестораны' },
  { code: 'personal_entertainment', label: 'Развлечения' },
  { code: 'personal_coffee', label: 'Кофе' },
  { code: 'personal_other', label: 'Прочее (личное)' },
];

/** Все варианты для выпадающего списка (бизнес + личные). */
export const ALL_CATEGORY_OPTIONS: CategoryOption[] = [
  ...BUSINESS_CATEGORY_OPTIONS,
  ...PERSONAL_CATEGORY_OPTIONS,
];

const CATEGORY_LABEL_BY_CODE: Record<string, string> = Object.fromEntries(
  ALL_CATEGORY_OPTIONS.map((c) => [c.code, c.label])
);

/** Человекочитаемая подпись по коду pnl_category (или null, если кода нет). */
export function categoryOptionLabel(code: string | null): string | null {
  if (code === null) return null;
  return CATEGORY_LABEL_BY_CODE[code] ?? code;
}
