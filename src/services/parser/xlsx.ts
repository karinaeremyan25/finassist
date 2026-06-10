import * as XLSX from 'xlsx';
import { childLogger } from '../../utils/logger.js';

/**
 * Парсер XLSX через SheetJS (xlsx 0.20+).
 *
 * Читает первый лист книги и возвращает строки как объекты (ключи —
 * заголовки первой строки) плюс список заголовков. Дальнейшая
 * классификация колонок выполняется на уровне роутера импорта
 * (логика та же, что в prodamus-csv).
 */

const log = childLogger({ handler: 'xlsx' });

export interface XlsxParseResult {
  success: boolean;
  rows: Record<string, unknown>[];
  headers: string[];
  sheetName: string;
  error?: string;
}

export async function parseXlsx(buffer: Buffer): Promise<XlsxParseResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { success: false, rows: [], headers: [], sheetName: '', error: 'EMPTY_BUFFER' };
  }

  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];

    if (sheetName === undefined) {
      return { success: false, rows: [], headers: [], sheetName: '', error: 'NO_SHEETS' };
    }

    const sheet = workbook.Sheets[sheetName];
    if (sheet === undefined) {
      return { success: false, rows: [], headers: [], sheetName, error: 'SHEET_UNREADABLE' };
    }

    // header: 1 → массив массивов; используем первую строку как заголовки,
    // чтобы корректно собрать объекты даже при дублирующихся именах колонок.
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: null,
    });

    if (matrix.length === 0) {
      return { success: false, rows: [], headers: [], sheetName, error: 'EMPTY_FILE' };
    }

    const headerRow = matrix[0] ?? [];
    const headers = headerRow.map((h) => (h === null || h === undefined ? '' : String(h).trim()));

    const rows: Record<string, unknown>[] = [];
    for (let i = 1; i < matrix.length; i++) {
      const dataRow = matrix[i] ?? [];
      const obj: Record<string, unknown> = {};
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c];
        if (key === undefined || key === '') continue;
        obj[key] = dataRow[c] ?? null;
      }
      rows.push(obj);
    }

    log.info({ sheet_name: sheetName, headers_count: headers.length, rows: rows.length }, 'xlsx_parsed');

    return { success: true, rows, headers, sheetName };
  } catch (err) {
    log.warn({ err }, 'xlsx_parse_failed');
    return {
      success: false,
      rows: [],
      headers: [],
      sheetName: '',
      error: 'CORRUPTED_FILE',
    };
  }
}
