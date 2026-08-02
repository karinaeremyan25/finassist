/**
 * Форматирование денег. Все суммы из API приходят в КОПЕЙКАХ (целые числа).
 * Никаких /100 по месту — только через этот модуль.
 */

const RUB_FORMAT = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: true,
});

/** "1 500,50 ₽" — пробел-разделитель тысяч, запятая-десятичные. */
export function rubles(kopecks: number): string {
  const rub = kopecks / 100;
  // Intl ru-RU уже даёт неразрывный пробел и запятую.
  return `${RUB_FORMAT.format(rub)} ₽`;
}

/** Со знаком: доход +, расход − (знак как носитель смысла, не только цвет). */
export function rublesSigned(kopecks: number): string {
  const sign = kopecks > 0 ? '+' : kopecks < 0 ? '−' : '';
  return `${sign}${rubles(Math.abs(kopecks))}`;
}

const RUB_INT_FORMAT = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
  useGrouping: true,
});

/**
 * Форма для KPI (выручка/расход): ПОЛНОЕ число без копеек и без сокращений.
 * "1 900 000 ₽" (не "1,9M"). По просьбе бухгалтерии — нужны полные цифры.
 */
export function rublesCompact(kopecks: number): string {
  return `${RUB_INT_FORMAT.format(Math.round(kopecks / 100))} ₽`;
}

/** Процент с фиксированным знаком: "+12,4%". */
export function percentSigned(value: number, digits = 1): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const fmt = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Math.abs(value));
  return `${sign}${fmt}%`;
}
