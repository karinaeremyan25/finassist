import { z } from 'zod';

export function toKopecks(input: string | number | bigint): bigint {
  if (typeof input === 'bigint') return input;

  // Убираем валютные символы/слова, НО НЕ десятичную точку.
  // Старый вариант /[₽руб.]/gi включал точку в класс символов и вырезал её —
  // из-за этого 153291.43 превращалось в 15329143 (×100 к сумме). Это ломало
  // все дробные суммы (балансы фондов раздувались в 100 раз).
  const str = String(input)
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/₽/g, '')
    .replace(/руб\.?/gi, '')
    .trim();

  const num = parseFloat(str);
  if (isNaN(num)) throw new Error(`Cannot parse amount: "${input}"`);

  // Round to avoid floating point artifacts
  return BigInt(Math.round(num * 100));
}

export function rubles(kopecks: bigint): string {
  const abs = kopecks < 0n ? -kopecks : kopecks;
  const whole = abs / 100n;
  const cents = abs % 100n;
  const sign = kopecks < 0n ? '−' : '';

  const formatted = whole
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // non-breaking space

  return `${sign}${formatted},${cents.toString().padStart(2, '0')} ₽`;
}

export function formatAmount(kopecks: bigint): string {
  return rubles(kopecks);
}

export const AmountSchema = z
  .union([z.string(), z.number()])
  .transform(val => toKopecks(val));
