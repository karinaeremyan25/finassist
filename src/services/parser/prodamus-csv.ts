import Papa from 'papaparse';
import { z } from 'zod';
import { childLogger } from '../../utils/logger.js';

/**
 * Парсер CSV-выписки Продамуса.
 *
 * Формат личного кабинета Продамус варьируется, поэтому колонки ищутся
 * нечётко по паттернам (рус/англ). Суммы парсятся в копейки (bigint),
 * без float в доменной модели.
 *
 * Полные данные строк (email покупателя и т.п.) НЕ логируются — только
 * агрегированная metadata.
 */

const log = childLogger({ handler: 'prodamus-csv' });

export interface ProdamusRow {
  externalId: string;
  occurredAt: string; // YYYY-MM-DD
  amountRub: bigint; // в копейках
  currency: string;
  productName: string;
  customerEmail: string | null;
  paymentMethod: string | null;
}

export interface ParseResult {
  success: boolean;
  formatDetected: string;
  rowsTotal: number;
  rowsParsed: ProdamusRow[];
  warnings: string[];
  error?: { code: string; message: string };
}

const InputSchema = z.object({
  content: z.string(),
});

export type ParseCsvInput = z.input<typeof InputSchema>;

/** Паттерны для нечёткого поиска колонок (проверяются как подстроки, lowercase). */
const COLUMN_PATTERNS = {
  date: ['date', 'дата', 'created', 'time', 'время'],
  amount: ['sum', 'amount', 'сумма', 'итого', 'total'],
  externalId: ['payment_id', 'order_id', 'id', 'номер', 'идентификатор'],
  product: ['product', 'товар', 'name', 'наименование', 'услуга'],
  email: ['email', 'e-mail', 'почта', 'покупатель', 'mail', 'client'],
  currency: ['currency', 'валюта'],
  paymentMethod: ['payment_method', 'method', 'способ', 'оплата'],
} as const;

type ColumnKey = keyof typeof COLUMN_PATTERNS;

/**
 * Находит для каждой логической колонки соответствующий заголовок из файла.
 * Для id-колонки приоритет точному совпадению "payment_id/order_id" перед "id",
 * чтобы не схватить, например, "user_id".
 */
function mapColumns(headers: string[]): Partial<Record<ColumnKey, string>> {
  const normalized = headers.map((h) => ({ original: h, lc: h.trim().toLowerCase() }));
  const mapping: Partial<Record<ColumnKey, string>> = {};

  for (const key of Object.keys(COLUMN_PATTERNS) as ColumnKey[]) {
    const patterns = COLUMN_PATTERNS[key];
    let found: string | undefined;
    // Сначала более специфичные (длинные) паттерны.
    const ordered = [...patterns].sort((a, b) => b.length - a.length);
    for (const pat of ordered) {
      const hit = normalized.find((h) => h.lc.includes(pat));
      if (hit) {
        found = hit.original;
        break;
      }
    }
    if (found !== undefined) {
      mapping[key] = found;
    }
  }

  return mapping;
}

/** Нормализует дату вида DD.MM.YYYY / YYYY-MM-DD / DD/MM/YYYY и ISO-таймстампы к YYYY-MM-DD. */
function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // ISO с временем: берём первые 10 символов, если это YYYY-MM-DD.
  const isoMatch = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (isoMatch) return isoMatch[1]!;

  // DD.MM.YYYY или DD/MM/YYYY
  const dmyMatch = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(trimmed);
  if (dmyMatch) {
    const dd = dmyMatch[1]!.padStart(2, '0');
    const mm = dmyMatch[2]!.padStart(2, '0');
    const yyyy = dmyMatch[3]!;
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

/** Парсит сумму "5 900,00" / "5900.00" / "5900" → копейки (bigint). */
function parseAmountToKopecks(raw: string): bigint | null {
  const cleaned = raw
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return BigInt(Math.round(num * 100));
}

export function parseProdamusCsv(input: ParseCsvInput): ParseResult {
  const { content } = InputSchema.parse(input);
  const warnings: string[] = [];

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: '', // авто-детект разделителя (, или ;)
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  if (headers.length === 0) {
    return {
      success: false,
      formatDetected: 'csv',
      rowsTotal: 0,
      rowsParsed: [],
      warnings,
      error: { code: 'EMPTY_FILE', message: 'В файле нет заголовков или строк.' },
    };
  }

  const columns = mapColumns(headers);

  // Обязательные колонки: дата, сумма, id.
  const missing: string[] = [];
  if (columns.date === undefined) missing.push('date');
  if (columns.amount === undefined) missing.push('sum');
  if (columns.externalId === undefined) missing.push('id');

  if (missing.length > 0) {
    log.warn({ headers, missing }, 'prodamus_csv_unknown_format');
    return {
      success: false,
      formatDetected: 'csv',
      rowsTotal: parsed.data.length,
      rowsParsed: [],
      warnings,
      error: {
        code: 'UNKNOWN_FORMAT',
        message: `Не удалось распознать структуру файла Продамуса. Не найдены колонки: ${missing.join(', ')}.`,
      },
    };
  }

  const dataRows = parsed.data;
  if (dataRows.length === 0) {
    return {
      success: false,
      formatDetected: 'csv',
      rowsTotal: 0,
      rowsParsed: [],
      warnings,
      error: { code: 'EMPTY_FILE', message: 'В файле нет транзакций для импорта.' },
    };
  }

  const rowsParsed: ProdamusRow[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!;
    const rowNum = i + 2; // +1 за заголовок, +1 за 1-индексацию

    const externalIdRaw = (row[columns.externalId!] ?? '').trim();
    const dateRaw = (row[columns.date!] ?? '').trim();
    const amountRaw = (row[columns.amount!] ?? '').trim();

    if (externalIdRaw === '') {
      warnings.push(`Строка ${rowNum}: пустой id — пропущена.`);
      continue;
    }
    if (seenIds.has(externalIdRaw)) {
      warnings.push(`Строка ${rowNum}: дубль id "${externalIdRaw}" внутри файла — пропущена.`);
      continue;
    }

    const occurredAt = normalizeDate(dateRaw);
    if (occurredAt === null) {
      warnings.push(`Строка ${rowNum}: не удалось распознать дату "${dateRaw}" — пропущена.`);
      continue;
    }

    const amountRub = parseAmountToKopecks(amountRaw);
    if (amountRub === null || amountRub <= 0n) {
      warnings.push(`Строка ${rowNum}: некорректная сумма "${amountRaw}" — пропущена.`);
      continue;
    }

    const currency =
      columns.currency !== undefined
        ? ((row[columns.currency] ?? '').trim().toUpperCase() || 'RUB')
        : 'RUB';
    const productName =
      columns.product !== undefined ? (row[columns.product] ?? '').trim() : '';
    const emailRaw = columns.email !== undefined ? (row[columns.email] ?? '').trim() : '';
    const methodRaw =
      columns.paymentMethod !== undefined ? (row[columns.paymentMethod] ?? '').trim() : '';

    seenIds.add(externalIdRaw);
    rowsParsed.push({
      externalId: externalIdRaw,
      occurredAt,
      amountRub,
      currency,
      productName,
      customerEmail: emailRaw === '' ? null : emailRaw,
      paymentMethod: methodRaw === '' ? null : methodRaw,
    });
  }

  if (rowsParsed.length === 0) {
    return {
      success: false,
      formatDetected: 'csv',
      rowsTotal: dataRows.length,
      rowsParsed: [],
      warnings,
      error: { code: 'EMPTY_FILE', message: 'Не удалось извлечь ни одной валидной транзакции.' },
    };
  }

  log.info(
    { rows_total: dataRows.length, rows_parsed: rowsParsed.length, warnings: warnings.length },
    'prodamus_csv_parsed'
  );

  return {
    success: true,
    formatDetected: 'csv',
    rowsTotal: dataRows.length,
    rowsParsed,
    warnings,
  };
}
