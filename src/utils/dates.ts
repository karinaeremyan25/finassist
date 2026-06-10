const MSK_OFFSET_HOURS = 3;

export interface TaxDeadline {
  quarter: number;
  deadlineMonth: number;
  deadlineDay: number;
}

export const USN_IP_DEADLINES: TaxDeadline[] = [
  { quarter: 1, deadlineMonth: 4, deadlineDay: 25 },
  { quarter: 2, deadlineMonth: 7, deadlineDay: 25 },
  { quarter: 3, deadlineMonth: 10, deadlineDay: 25 },
  { quarter: 4, deadlineMonth: 4, deadlineDay: 28 }, // следующий год
];

// УСН ООО: финальная дата — 28 марта следующего года
export const USN_OOO_DEADLINES: TaxDeadline[] = [
  { quarter: 1, deadlineMonth: 4, deadlineDay: 28 },
  { quarter: 2, deadlineMonth: 7, deadlineDay: 28 },
  { quarter: 3, deadlineMonth: 10, deadlineDay: 28 },
  { quarter: 4, deadlineMonth: 3, deadlineDay: 28 }, // следующий год
];

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function nextBusinessDay(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  while (isWeekend(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

export function getDeadlineDate(deadline: TaxDeadline, year: number): Date {
  const d = new Date(year, deadline.deadlineMonth - 1, deadline.deadlineDay);
  if (isWeekend(d)) return nextBusinessDay(d);
  return d;
}

export function getNextTaxDeadline(
  deadlines: TaxDeadline[],
  from: Date = new Date()
): { deadline: TaxDeadline; date: Date; year: number } | null {
  const currentYear = from.getFullYear();

  for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
    const year = currentYear + yearOffset;
    for (const dl of deadlines) {
      const date = getDeadlineDate(
        dl,
        dl.quarter === 4 && dl.deadlineMonth < 6 ? year + 1 : year
      );
      if (date > from) {
        return { deadline: dl, date, year };
      }
    }
  }
  return null;
}

export function daysUntil(target: Date, from: Date = new Date()): number {
  const ms = target.getTime() - from.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export interface Period {
  dateFrom: string;
  dateTo: string;
}

export function getCurrentMonthPeriod(): Period {
  const now = new Date();
  const dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const dateTo = formatDate(last);
  return { dateFrom, dateTo };
}

export function getLastMonthPeriod(): Period {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { dateFrom: formatDate(first), dateTo: formatDate(last) };
}

export function getCurrentQuarterPeriod(): Period {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3);
  const first = new Date(now.getFullYear(), quarter * 3, 1);
  const last = new Date(now.getFullYear(), quarter * 3 + 3, 0);
  return { dateFrom: formatDate(first), dateTo: formatDate(last) };
}

export function getYTDPeriod(): Period {
  const now = new Date();
  return {
    dateFrom: `${now.getFullYear()}-01-01`,
    dateTo: formatDate(now),
  };
}

export function getWeekPeriod(weekEndDate: Date): Period {
  const end = new Date(weekEndDate);
  const start = new Date(weekEndDate);
  start.setDate(start.getDate() - 6);
  return { dateFrom: formatDate(start), dateTo: formatDate(end) };
}

export function getPreviousPeriod(period: Period): Period {
  const from = new Date(period.dateFrom);
  const to = new Date(period.dateTo);
  const durationMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - durationMs);
  return { dateFrom: formatDate(prevFrom), dateTo: formatDate(prevTo) };
}

export function parsePeriod(label: string): Period | null {
  const now = new Date();
  const lc = label.toLowerCase();

  if (lc === 'this_month' || lc === 'этот месяц') return getCurrentMonthPeriod();
  if (lc === 'last_month' || lc === 'прошлый месяц') return getLastMonthPeriod();
  if (lc === 'this_quarter' || lc === 'этот квартал') return getCurrentQuarterPeriod();
  if (lc === 'ytd' || lc === 'с начала года') return getYTDPeriod();

  // YYYY-MM format
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(label);
  if (monthMatch) {
    const year = parseInt(monthMatch[1]!, 10);
    const month = parseInt(monthMatch[2]!, 10);
    const first = new Date(year, month - 1, 1);
    const last = new Date(year, month, 0);
    return { dateFrom: formatDate(first), dateTo: formatDate(last) };
  }

  return null;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatDateMSK(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const msk = new Date(d.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
  const day = msk.getUTCDate();
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  return `${day} ${months[msk.getUTCMonth()]} ${msk.getUTCFullYear()}`;
}

export function formatDateShort(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const msk = new Date(d.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
  const dd = String(msk.getUTCDate()).padStart(2, '0');
  const mm = String(msk.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${msk.getUTCFullYear()}`;
}

export function todayMSK(): string {
  const msk = new Date(Date.now() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
  return msk.toISOString().slice(0, 10);
}
