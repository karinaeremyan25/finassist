import { z } from 'zod';
import { sql } from '../db/client.js';
import { childLogger } from '../utils/logger.js';

/**
 * Курсы валют ЦБ РФ.
 *
 * Источник: https://www.cbr.ru/scripts/XML_daily.asp?date_req=DD/MM/YYYY
 * (публичный XML, без ключа). В числах ЦБ используется запятая как
 * десятичный разделитель ("92,5430").
 *
 * - Кешируем в таблице fx_rates (UNIQUE rate_date+currency).
 * - При недоступности ЦБ — используем последний известный курс из БД + warning.
 * - Hardcoded fallback (USD=90, EUR=100, KZT=0.20) — только если в БД пусто.
 */

const log = childLogger({ handler: 'cbr' });

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const HTTP_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

/** Валюты, которые отслеживаем (соответствует CHECK в таблице fx_rates). */
const TRACKED_CURRENCIES = ['USD', 'EUR', 'KZT'] as const;
type TrackedCurrency = (typeof TRACKED_CURRENCIES)[number];

/** Hardcoded fallback на самый первый запуск (БД пуста, ЦБ недоступен). */
const HARDCODED_FALLBACK: Record<string, number> = {
  USD: 90,
  EUR: 100,
  KZT: 0.2,
};

export interface FxRate {
  rateDate: string; // YYYY-MM-DD
  currency: string;
  rateToRub: number;
}

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

const CurrencySchema = z.string().min(1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD → DD/MM/YYYY (формат date_req у ЦБ). */
function toCbrDate(iso: string): string {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}/${mm}/${yyyy}`;
}

/** Скачивает XML ЦБ с таймаутом и retry (1s/3s/9s). */
async function fetchCbrXml(cbrDate: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const url = `${CBR_URL}?date_req=${cbrDate}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`CBR responded with HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      lastError = err;
      log.warn({ attempt: attempt + 1, cbr_date: cbrDate }, 'cbr_fetch_failed');
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`CBR fetch failed after ${MAX_ATTEMPTS} attempts`, { cause: lastError });
}

/**
 * Извлекает курсы нужных валют из XML ЦБ.
 * Учитывает Nominal (например, KZT котируется за 100 единиц) и
 * запятую как десятичный разделитель.
 */
function parseCbrXml(xml: string): Map<TrackedCurrency, number> {
  const result = new Map<TrackedCurrency, number>();

  // Каждый <Valute ...> ... </Valute> разбираем по отдельности.
  const valuteRe = /<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g;
  let match: RegExpExecArray | null;

  while ((match = valuteRe.exec(xml)) !== null) {
    const block = match[1]!;
    const charCode = /<CharCode>\s*([A-Z]{3})\s*<\/CharCode>/.exec(block)?.[1];
    if (charCode === undefined) continue;
    if (!(TRACKED_CURRENCIES as readonly string[]).includes(charCode)) continue;

    const nominalRaw = /<Nominal>\s*([\d\s.,]+?)\s*<\/Nominal>/.exec(block)?.[1] ?? '1';
    const valueRaw = /<Value>\s*([\d\s.,]+?)\s*<\/Value>/.exec(block)?.[1];
    if (valueRaw === undefined) continue;

    const nominal = parseFloat(nominalRaw.replace(/\s/g, '').replace(',', '.'));
    const value = parseFloat(valueRaw.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(nominal) || !Number.isFinite(value) || nominal === 0) continue;

    // Курс за 1 единицу валюты в рублях.
    const rateToRub = value / nominal;
    result.set(charCode as TrackedCurrency, Number(rateToRub.toFixed(4)));
  }

  return result;
}

/**
 * Получить курсы USD/EUR/KZT с ЦБ РФ на дату и сохранить в fx_rates.
 * @param date YYYY-MM-DD, по умолчанию сегодня.
 */
export async function fetchAndStoreFxRates(date?: string): Promise<FxRate[]> {
  const rateDate = DateSchema.parse(date) ?? todayIso();
  const cbrDate = toCbrDate(rateDate);

  const xml = await fetchCbrXml(cbrDate);
  const rates = parseCbrXml(xml);

  if (rates.size === 0) {
    log.warn({ rate_date: rateDate }, 'cbr_no_rates_in_xml');
    return [];
  }

  const stored: FxRate[] = [];
  for (const [currency, rateToRub] of rates) {
    await sql`
      INSERT INTO fx_rates (rate_date, currency, rate_to_rub, source)
      VALUES (${rateDate}, ${currency}, ${rateToRub}, 'cbr.ru')
      ON CONFLICT (rate_date, currency)
      DO UPDATE SET rate_to_rub = EXCLUDED.rate_to_rub
    `;
    stored.push({ rateDate, currency, rateToRub });
  }

  log.info({ rate_date: rateDate, currencies: stored.map((r) => r.currency) }, 'cbr_rates_stored');
  return stored;
}

/** Курс на точную дату из БД. */
async function selectExactRate(currency: string, date: string): Promise<number | null> {
  const rows = await sql<{ rate_to_rub: string }[]>`
    SELECT rate_to_rub
    FROM fx_rates
    WHERE currency = ${currency} AND rate_date = ${date}
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : Number(row.rate_to_rub);
}

/** Последний известный курс на дату <= date. */
async function selectLatestRate(currency: string, date: string): Promise<number | null> {
  const rows = await sql<{ rate_to_rub: string }[]>`
    SELECT rate_to_rub
    FROM fx_rates
    WHERE currency = ${currency} AND rate_date <= ${date}
    ORDER BY rate_date DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : Number(row.rate_to_rub);
}

/**
 * Курс валюты к рублю на дату.
 *
 * Порядок: точная дата → последний <= date → дозагрузка с ЦБ и повтор →
 * hardcoded fallback (только если БД совсем пуста по валюте).
 */
export async function getRate(currency: string, date: string): Promise<number> {
  const curr = CurrencySchema.parse(currency).toUpperCase();
  const dateParsed = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(date);

  if (curr === 'RUB') return 1;

  const exact = await selectExactRate(curr, dateParsed);
  if (exact !== null) return exact;

  const latest = await selectLatestRate(curr, dateParsed);
  if (latest !== null) return latest;

  // Ничего нет — пробуем дозагрузить с ЦБ на эту дату.
  try {
    await fetchAndStoreFxRates(dateParsed);
    const afterFetch = await selectLatestRate(curr, dateParsed);
    if (afterFetch !== null) return afterFetch;
  } catch (err) {
    log.warn({ err, currency: curr, date: dateParsed }, 'cbr_fetch_for_rate_failed');
  }

  const fallback = HARDCODED_FALLBACK[curr];
  if (fallback !== undefined) {
    log.warn({ currency: curr, date: dateParsed, fallback }, 'cbr_hardcoded_fallback_used');
    return fallback;
  }

  throw new Error(`No FX rate available for ${curr} on ${dateParsed}`);
}

const ConvertSchema = z.object({
  amountCents: z.bigint(),
  currency: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type ConvertInput = z.input<typeof ConvertSchema>;

/**
 * Пересчёт суммы в рубли по курсу на дату.
 *
 * Для RUB: amountRub = amountCents, fxRate = null.
 * Иначе: amountRub = round(amountCents * rateToRub) — т.к. amountCents в
 * минимальных единицах валюты (центы), а rateToRub — рублей за 1 единицу.
 */
export async function convertToRub(
  amountCents: bigint,
  currency: string,
  date: string
): Promise<{ amountRub: bigint; fxRate: number | null }> {
  ConvertSchema.parse({ amountCents, currency, date });
  const curr = currency.toUpperCase();

  if (curr === 'RUB') {
    return { amountRub: amountCents, fxRate: null };
  }

  const rate = await getRate(curr, date);
  // amountCents (центы) * rate (руб/ед.) = копейки рублёвого эквивалента.
  const amountRub = BigInt(Math.round(Number(amountCents) * rate));
  return { amountRub, fxRate: rate };
}
