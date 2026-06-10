import { createRequire } from 'node:module';
import { childLogger } from '../../utils/logger.js';

/**
 * Парсер PDF через pdf-parse (1.1+).
 *
 * Извлекает текстовый слой PDF. Дальнейшая классификация извлечённого
 * текста выполняется через Claude (services/classifier.ts).
 *
 * Примечание: pdf-parse в ESM подключаем через createRequire — пакет
 * предоставляет CommonJS-функцию с дефолтным экспортом, а его index.js
 * содержит debug-код, выполняющийся только при прямом запуске файла.
 */

const log = childLogger({ handler: 'pdf' });

interface PdfParseFn {
  (dataBuffer: Buffer): Promise<{ text: string; numpages: number }>;
}

const require = createRequire(import.meta.url);

export interface PdfParseResult {
  success: boolean;
  text: string;
  pages: number;
  error?: string;
}

export async function parsePdf(buffer: Buffer): Promise<PdfParseResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { success: false, text: '', pages: 0, error: 'EMPTY_BUFFER' };
  }

  try {
    // Подключаем lib напрямую, минуя index.js с его debug-веткой.
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') as PdfParseFn;
    const data = await pdfParse(buffer);
    const text = (data.text ?? '').trim();

    if (text === '') {
      log.warn({ pages: data.numpages }, 'pdf_no_text_layer');
      return {
        success: false,
        text: '',
        pages: data.numpages ?? 0,
        error: 'NO_TEXT_LAYER',
      };
    }

    log.info({ pages: data.numpages, text_length: text.length }, 'pdf_parsed');
    return { success: true, text, pages: data.numpages ?? 0 };
  } catch (err) {
    log.warn({ err }, 'pdf_parse_failed');
    return { success: false, text: '', pages: 0, error: 'CORRUPTED_FILE' };
  }
}
