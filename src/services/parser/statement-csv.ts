import Papa from 'papaparse';
import { z } from 'zod';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'statement-csv' });

export interface StatementRow {
  externalId: string | null;
  occurredAt: string;
  amountRub: bigint;
  currency: string;
  productName: string;
  customerEmail: string | null;
  paymentMethod: string | null;
  flowType: 'income' | 'expense';
}

export interface ParseResult {
  success: boolean;
  formatDetected: string;
  rowsTotal: number;
  rowsParsed: StatementRow[];
  warnings: string[];
  error?: { code: string; message: string };
}

const InputSchema = z.object({
  content: z.string(),
});

type ColumnKey =
  | 'date'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'externalId'
  | 'description'
  | 'currency'
  | 'email'
  | 'paymentMethod';

const COLUMN_PATTERNS: Record<ColumnKey, string[]> = {
  date: ['date', 'дата', 'created', 'time', 'время', 'operation date', 'transaction date'],
  amount: ['sum', 'amount', 'сумма', 'итого', 'total', 'amount_rub'],
  debit: ['debit', 'расход', 'expense', 'списано', 'outflow', 'выход'],
  credit: ['credit', 'поступление', 'income', 'receipt', 'inflow', 'приход'],
  externalId: ['payment_id', 'order_id', 'transaction_id', 'id', 'номер', 'invoice', 'doc id', 'document'],
  description: ['description', 'comment', 'комментарий', 'назначение', 'operation', 'purpose', 'описание', 'message'],
  currency: ['currency', 'валюта', 'curr', 'currency_code'],
  email: ['email', 'e-mail', 'почта', 'покупатель', 'client', 'customer'],
  paymentMethod: ['payment_method', 'method', 'способ', 'оплата', 'payment type'],
};

function mapColumns(headers: string[]): Partial<Record<ColumnKey, string>> {
  const normalized = headers.map((h) => ({ original: h, lc: h.trim().toLowerCase() }));
  const mapping: Partial<Record<ColumnKey, string>> = {};

  for (const key of Object.keys(COLUMN_PATTERNS) as ColumnKey[]) {
    const patterns = COLUMN_PATTERNS[key];
    for (const pat of patterns) {
      const hit = normalized.find((h) => h.lc.includes(pat));
      if (hit) {
        mapping[key] = hit.original;
        break;
      }
    }
  }

  return mapping;
}

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const isoMatch = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (isoMatch) return isoMatch[1]!;

  const dmyMatch = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(trimmed);
  if (dmyMatch) {
    const dd = dmyMatch[1]!.padStart(2, '0');
    const mm = dmyMatch[2]!.padStart(2, '0');
    const yyyy = dmyMatch[3]!;
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function parseAmountToKopecks(raw: string): bigint | null {
  const cleaned = raw
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '+') return null;
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return BigInt(Math.round(Math.abs(num) * 100));
}

function extractString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function detectFlowType(row: Record<string, unknown>, columns: Partial<Record<ColumnKey, string>>): 'income' | 'expense' {
  const creditRaw = columns.credit ? extractString(row[columns.credit]) : '';
  const debitRaw = columns.debit ? extractString(row[columns.debit]) : '';

  if (creditRaw !== '' && debitRaw === '') return 'income';
  if (debitRaw !== '' && creditRaw === '') return 'expense';

  const amountRaw = extractString(row[columns.amount ?? ''] ?? '');
  if (amountRaw.startsWith('-')) return 'expense';
  return 'income';
}

export type ParseCsvInput = z.input<typeof InputSchema>;

export function parseStatementCsv(input: ParseCsvInput): ParseResult {
  const { content } = InputSchema.parse(input);
  const warnings: string[] = [];

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: '',
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
  if (columns.date === undefined || columns.amount === undefined) {
    log.warn({ headers, columns }, 'statement_csv_unknown_format');
    return {
      success: false,
      formatDetected: 'csv',
      rowsTotal: parsed.data.length,
      rowsParsed: [],
      warnings,
      error: {
        code: 'UNKNOWN_FORMAT',
        message: 'Не удалось распознать обязательные колонки: дата и сумма.',
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
      error: { code: 'EMPTY_FILE', message: 'Файл не содержит транзакций.' },
    };
  }

  const rowsParsed: StatementRow[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!;
    const rowNum = i + 2;

    const externalId = columns.externalId ? extractString(row[columns.externalId]) : '';
    const dateRaw = extractString(row[columns.date]);
    const amountRaw = extractString(row[columns.amount]);

    const occurredAt = normalizeDate(dateRaw);
    if (!occurredAt) {
      warnings.push(`Строка ${rowNum}: не удалось распознать дату "${dateRaw}" — пропущена.`);
      continue;
    }

    const amountRub = parseAmountToKopecks(amountRaw);
    if (amountRub === null || amountRub <= 0n) {
      warnings.push(`Строка ${rowNum}: некорректная сумма "${amountRaw}" — пропущена.`);
      continue;
    }

    const currency = columns.currency ? extractString(row[columns.currency]).toUpperCase() || 'RUB' : 'RUB';
    const productName = columns.description ? extractString(row[columns.description]) : '';
    const emailRaw = columns.email ? extractString(row[columns.email]) : '';
    const methodRaw = columns.paymentMethod ? extractString(row[columns.paymentMethod]) : '';

    const flowType = detectFlowType(row, columns);

    rowsParsed.push({
      externalId: externalId === '' ? null : externalId,
      occurredAt,
      amountRub,
      currency,
      productName,
      customerEmail: emailRaw === '' ? null : emailRaw,
      paymentMethod: methodRaw === '' ? null : methodRaw,
      flowType,
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

  log.info({ rows_total: dataRows.length, rows_parsed: rowsParsed.length, warnings: warnings.length }, 'statement_csv_parsed');

  return {
    success: true,
    formatDetected: 'csv',
    rowsTotal: dataRows.length,
    rowsParsed,
    warnings,
  };
}
