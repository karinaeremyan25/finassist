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
