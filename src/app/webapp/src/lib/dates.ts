/**
 * Даты из API приходят в UTC (ISO). Отображаем в МСК (UTC+3).
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

const MONTHS_FULL = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

function toMsk(iso: string): Date {
  return new Date(new Date(iso).getTime() + MSK_OFFSET_MS);
}

/** YYYY-MM-DD дня операции в МСК — ключ для группировки по дням. */
export function mskDayKey(iso: string): string {
  const d = toMsk(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
}

/** "8 июня" — заголовок-дата для группы операций (МСК, родительный падеж). */
export function formatDayLabel(iso: string): string {
  const d = toMsk(iso);
  return `${d.getUTCDate()} ${MONTHS_GENITIVE[d.getUTCMonth()]}`;
}

/** "8 июн" — короткая дата операции в МСК. */
export function formatDateShort(iso: string): string {
  const d = toMsk(iso);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** "8 июн, 14:30" — дата+время в МСК. */
export function formatDateTime(iso: string): string {
  const d = toMsk(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}, ${hh}:${mm}`;
}

/** "Июнь 2026" — из YYYY-MM-DD периода. */
export function formatMonthLabel(fromYmd: string): string {
  const [y, m] = fromYmd.split('-').map((s) => Number(s));
  const idx = (m ?? 1) - 1;
  return `${MONTHS_FULL[idx] ?? ''} ${y ?? ''}`.trim();
}

/** YYYY-MM-DD начала текущего месяца (локально-достаточно). */
export function currentMonthFrom(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** YYYY-MM-DD сегодня. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}
