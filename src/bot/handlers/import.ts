import path from 'path';
import fs from 'fs/promises';
import type { BotContextWithSession } from '../middleware/session.js';
import { InlineKeyboard } from 'grammy';
import { parseProdamusCsv } from '../../services/parser/prodamus-csv.js';
import { parseStatementCsv } from '../../services/parser/statement-csv.js';
import { parseXlsx } from '../../services/parser/xlsx.js';
import { parsePdf } from '../../services/parser/pdf.js';
import { createTransaction, getTransactionsByExternalIds } from '../../db/repositories/transactions.js';
import { sql } from '../../db/client.js';
import { rubles } from '../../utils/money.js';
import { childLogger } from '../../utils/logger.js';
import { config } from '../../config.js';

const log = childLogger({ handler: 'import' });
const UPLOAD_DIR = 'uploads/unparsed';

const IMPORT_SOURCES: Record<string, { label: string; prompt: string }> = {
  prodamus: { label: 'Продамус', prompt: 'Пришлите файл выписки Продамуса.' },
  robokassa: { label: 'Робокасса', prompt: 'Пришлите файл выписки Робокассы.' },
  tochka: { label: 'Точка (Ассургина)', prompt: 'Пришлите файл выписки Точки.' },
};

export async function handleImport(ctx: BotContextWithSession): Promise<void> {
  const kb = new InlineKeyboard()
    .text('Продамус', 'import:source:prodamus')
    .row()
    .text('Робокасса', 'import:source:robokassa')
    .text('Точка', 'import:source:tochka');

  await ctx.session.set('awaiting_statement_source', {});
  await ctx.reply(
    '📎 Выберите источник выписки.\n\n' +
    'Поддерживаемые форматы: CSV, XLSX, PDF.\n' +
    'Лимит размера: 20 МБ.\n\n' +
    'Чтобы отменить: /cancel',
    { reply_markup: kb }
  );
}

export async function handleImportSource(ctx: BotContextWithSession): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const data = ctx.callbackQuery?.data ?? '';
  const parts = data.split(':');
  const sourceCode = parts[2] ?? 'prodamus';
  let source = IMPORT_SOURCES[sourceCode as keyof typeof IMPORT_SOURCES] as { label: string; prompt: string } | undefined;
  if (!source) source = IMPORT_SOURCES.prodamus;

  await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery!.message!.message_id,
    `📎 ${source!.prompt}\n\n` +
    'Поддерживаемые форматы: CSV, XLSX, PDF.\n' +
    'Лимит размера: 20 МБ.\n\n' +
    'Чтобы отменить: /cancel'
  );
  await ctx.session.set('awaiting_statement_file', { sourceCode });
}

export async function handleImportFile(ctx: BotContextWithSession): Promise<void> {
  const session = await ctx.session.get();
  if (session?.state !== 'awaiting_statement_file') {
    // Файл без команды — подсказка
    await ctx.reply('📎 Чтобы загрузить выписку, сначала отправьте /import и выберите источник.');
    return;
  }

  const sourceCode = String(session.context.sourceCode ?? 'prodamus');
  const doc = ctx.message?.document;
  if (!doc) return;

  if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
    await ctx.reply('❌ Файл слишком большой (лимит Telegram — 20 МБ). Разбейте выписку на части.');
    return;
  }

  const ext = path.extname(doc.file_name ?? '').toLowerCase();
  if (!['.csv', '.xlsx', '.xls', '.pdf'].includes(ext)) {
    await ctx.reply('❌ Формат файла не поддерживается. Принимаются: CSV, XLSX, PDF.');
    return;
  }

  const loadingMsg = await ctx.reply('⏳ Парсю файл...');

  let buffer: Buffer;
  try {
    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path ?? ''}`;
    const resp = await fetch(url);
    buffer = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id }, 'import_download_error');
    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
      '❌ Не удалось скачать файл. Попробуйте ещё раз.'
    );
    return;
  }

  try {
    let rows: Array<{
      externalId: string | null; occurredAt: string; amountRub: bigint;
      currency: string; productName: string; customerEmail: string | null;
      paymentMethod: string | null; flowType: 'income' | 'expense';
    }> = [];
    let formatDetected = 'unknown';

    if (ext === '.csv') {
      const content = buffer.toString('utf-8');
      const parsed = sourceCode === 'prodamus'
        ? parseProdamusCsv({ content })
        : parseStatementCsv({ content });

      if (!parsed.success || parsed.error) {
        await saveUnparsed(buffer, doc.file_name ?? 'file');
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          `⚠️ Не удалось распознать структуру файла. Файл сохранён для разбора.`
        );
        await ctx.session.clear();
        return;
      }

      rows = parsed.rowsParsed.map((r) => ({
        externalId: r.externalId,
        occurredAt: r.occurredAt,
        amountRub: r.amountRub,
        currency: r.currency,
        productName: r.productName,
        customerEmail: r.customerEmail,
        paymentMethod: r.paymentMethod,
        flowType: 'flowType' in r ? r.flowType : 'income',
      }));
      formatDetected = 'CSV';
    } else if (ext === '.xlsx' || ext === '.xls') {
      const xlsxResult = await parseXlsx(buffer);
      if (!xlsxResult.success || xlsxResult.rows.length === 0) {
        await saveUnparsed(buffer, doc.file_name ?? 'file');
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          `⚠️ Не удалось распознать структуру XLSX-файла. Файл сохранён.`
        );
        await ctx.session.clear();
        return;
      }

      const csvLike = [
        xlsxResult.headers.join(','),
        ...xlsxResult.rows.map((r) =>
          xlsxResult.headers.map((h) => {
            const value = (r as Record<string, unknown>)[h];
            return value === null || value === undefined ? '' : String(value).replace(/\n/g, ' ');
          }).join(',')
        ),
      ].join('\n');

      const parsed = sourceCode === 'prodamus'
        ? parseProdamusCsv({ content: csvLike })
        : parseStatementCsv({ content: csvLike });

      if (!parsed.success || parsed.error) {
        await saveUnparsed(buffer, doc.file_name ?? 'file');
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          `⚠️ Не удалось распознать структуру XLSX-файла. Файл сохранён.`
        );
        await ctx.session.clear();
        return;
      }

      rows = parsed.rowsParsed.map((r) => ({
        externalId: r.externalId,
        occurredAt: r.occurredAt,
        amountRub: r.amountRub,
        currency: r.currency,
        productName: r.productName,
        customerEmail: r.customerEmail,
        paymentMethod: r.paymentMethod,
        flowType: 'flowType' in r ? r.flowType : 'income',
      }));
      formatDetected = 'XLSX';
    } else if (ext === '.pdf') {
      const pdfResult = await parsePdf(buffer);
      if (!pdfResult.success || !pdfResult.text) {
        await saveUnparsed(buffer, doc.file_name ?? 'file');
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          `⚠️ Не удалось извлечь текст из PDF. Файл сохранён для разбора.`
        );
        await ctx.session.clear();
        return;
      }
      // PDF → parse lines manually (упрощённая логика)
      await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
        `⚠️ PDF-выписки поддерживаются частично. Проверьте результат через /verify.`
      );
      await ctx.session.clear();
      return;
    }

    if (rows.length === 0) {
      await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
        '⚠️ В файле нет транзакций для импорта.'
      );
      await ctx.session.clear();
      return;
    }

    // Дедупликация
    const extIds = rows.flatMap((r) => (r.externalId ? [r.externalId] : []));
    const existingIds = await getTransactionsByExternalIds(extIds);
    const existingSet = new Set(existingIds);

    // Маппинг по product_name
    const mappings = await sql<{ product_pattern: string; match_type: string; direction_id: string; entity_id: string; category_id: string | null }[]>`
      SELECT product_pattern, match_type, direction_id, entity_id, category_id
      FROM prodamus_product_mapping WHERE is_active = true ORDER BY match_type ASC
    `;
    const prodamusSourceRow = await sql<{ id: string }[]>`SELECT id FROM sources WHERE code = 'prodamus'`;
    const prodamusSourceId = prodamusSourceRow[0]?.id ?? '';

    const sourceRow = await sql<{ id: string; display_name: string; entity_id: string | null }[]>`
      SELECT id, display_name, entity_id
      FROM sources
      WHERE code = ${sourceCode}
    `;
    const sourceId = sourceRow[0]?.id ?? prodamusSourceId;
    const sourceName = sourceRow[0]?.display_name ?? IMPORT_SOURCES[sourceCode as keyof typeof IMPORT_SOURCES]?.label ?? 'Продамус';
    const sourceEntityId = sourceRow[0]?.entity_id ?? null;

    const userRow = await sql<{ id: string }[]>`SELECT id FROM app_users WHERE telegram_id = ${BigInt(ctx.from!.id)}`;
    const userId = userRow[0]?.id ?? '';

    const defaultIpRow = await sql<{ id: string }[]>`SELECT id FROM entities WHERE code = 'ip_eremyan'`;
    const defaultIpEntityId = defaultIpRow[0]?.id ?? '';

    let imported = 0, dupes = 0, unclassified = 0;
    let totalAmountKopecks = 0n;
    const directionCounts: Record<string, number> = {};

    for (const row of rows) {
      if (row.externalId !== null && existingSet.has(row.externalId)) { dupes++; continue; }

      // Найти маппинг по product_name
      let directionId: string | null = null;
      let entityId: string | null = null;
      let categoryId: string | null = null;
      let needsClassification = false;

      for (const m of mappings) {
        const product = row.productName ?? '';
        let match = false;
        if (m.match_type === 'exact') match = product === m.product_pattern;
        else if (m.match_type === 'contains') match = product.toLowerCase().includes(m.product_pattern.toLowerCase());
        else if (m.match_type === 'regex') {
          try { match = new RegExp(m.product_pattern, 'i').test(product); } catch { match = false; }
        }
        if (match) { directionId = m.direction_id; entityId = m.entity_id; categoryId = m.category_id; break; }
      }

      if (!directionId) { needsClassification = true; unclassified++; }

      if (!entityId) {
        entityId = sourceEntityId ?? defaultIpEntityId;
      }

      if (!entityId || !sourceId) continue;

      await createTransaction({
        flowType: row.flowType,
        amount: row.amountRub,
        currency: 'RUB',
        amountRub: row.amountRub,
        entityId,
        directionId,
        categoryId,
        sourceId,
        occurredAt: row.occurredAt,
        description: row.productName ? `${sourceName}: ${row.productName}` : sourceName,
        externalId: row.externalId,
        createdBy: userId,
        verified: false,
        needsClassification,
        aiConfidence: null,
      });

      imported++;
      totalAmountKopecks += row.amountRub;
      if (directionId) {
        const dirRow = await sql<{ display_name: string }[]>`SELECT display_name FROM directions WHERE id = ${directionId}`;
        const dn = dirRow[0]?.display_name ?? directionId;
        directionCounts[dn] = (directionCounts[dn] ?? 0) + 1;
      }
    }

    await ctx.session.clear();

    const dirLines = Object.entries(directionCounts)
      .map(([name, cnt]) => `• ${name}: ${cnt} операций`)
      .join('\n');

    const reviewKb = new InlineKeyboard().text('📋 Проверить нераспознанные', 'import:review_unclassified');

    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
      `✅ Выписка обработана (${formatDetected}).\n\n` +
      `📊 Загружено:\n` +
      `• Всего строк: ${rows.length}\n` +
      `• Импортировано: ${imported}\n` +
      `• Дубликатов пропущено: ${dupes}\n` +
      `• Сумма поступлений: ${rubles(totalAmountKopecks)}\n\n` +
      (dirLines ? `📁 По направлениям:\n${dirLines}\n\n` : '') +
      (unclassified > 0 ? `⚠️ Не классифицировано: ${unclassified} операций` : ''),
      { reply_markup: unclassified > 0 ? reviewKb : undefined }
    );

    log.info({ telegram_id: ctx.from?.id, imported, dupes, unclassified, format: formatDetected }, 'import_done');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id }, 'import_parse_error');
    await saveUnparsed(buffer, doc.file_name ?? 'file');
    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
      '⚠️ Ошибка при обработке файла. Файл сохранён для разбора. Скиньте собственнику.'
    );
    await ctx.session.clear();
  }
}

export async function handleImportCallback(ctx: BotContextWithSession): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const data = ctx.callbackQuery?.data ?? '';
  if (data === 'import:review_unclassified') {
    await ctx.reply('Для просмотра нераспознанных транзакций используйте /verify');
  }
}

async function saveUnparsed(buffer: Buffer, filename: string): Promise<void> {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    await fs.writeFile(path.join(UPLOAD_DIR, `${ts}_${filename}`), buffer);
  } catch { /* ignore */ }
}
