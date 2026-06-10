import { InlineKeyboard } from 'grammy';
import type { BotContextWithSession } from '../middleware/session.js';
import { handleCustomPercentInput } from './distribute.js';
import { handleSettingValueInput } from './settings.js';
import { handleImportFile } from './import.js';
import { classify } from '../../services/classifier.js';
import { createTransaction } from '../../db/repositories/transactions.js';
import { proposeAllocation } from '../../services/funds.js';
import { sql } from '../../db/client.js';
import { rubles, toKopecks } from '../../utils/money.js';
import { todayMSK, formatDateMSK } from '../../utils/dates.js';
import { childLogger } from '../../utils/logger.js';
import { config } from '../../config.js';
import type { ClassificationResult } from '../../types.js';

const log = childLogger({ handler: 'add' });

// ─── Утилиты ──────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function buildCard(result: ClassificationResult, entityName: string, dirName: string, catName: string, sourceName: string): string {
  const icon = result.type === 'expense' ? '📤 Расход' : '📥 Поступление';
  const lines = [
    `${icon}: *${esc(rubles(result.amountRub))}*`,
    `🏢 ${esc(entityName)}`,
    `📁 ${esc(dirName)} → ${esc(catName)}`,
    `💳 ${esc(sourceName)}`,
    `📅 ${esc(formatDateMSK(result.occurredAt))}`,
  ];
  if (result.description) lines.push(`📝 ${esc(result.description)}`);
  return lines.join('\n');
}

async function lookupRefs(result: ClassificationResult) {
  const [entityRows, dirRows, catRows, srcRows] = await Promise.all([
    sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM entities WHERE code = ${result.entityCode}`,
    result.directionCode
      ? sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM directions WHERE code = ${result.directionCode}`
      : Promise.resolve([]),
    result.categoryCode
      ? sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM categories WHERE code = ${result.categoryCode}`
      : Promise.resolve([]),
    result.sourceCode
      ? sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM sources WHERE code = ${result.sourceCode}`
      : Promise.resolve([]),
  ]);
  return {
    entityId: entityRows[0]?.id ?? '',
    entityName: entityRows[0]?.display_name ?? result.entityCode,
    directionId: dirRows[0]?.id ?? null,
    dirName: dirRows[0]?.display_name ?? 'Не определено',
    categoryId: catRows[0]?.id ?? null,
    catName: catRows[0]?.display_name ?? 'Не определено',
    sourceId: srcRows[0]?.id ?? '',
    sourceName: srcRows[0]?.display_name ?? 'Не определено',
  };
}

function confirmKb(tempId: string) {
  return new InlineKeyboard()
    .text('✅ Записать', `tx:confirm:${tempId}`)
    .text('✏️ Изменить', `tx:edit:${tempId}`)
    .text('❌ Отмена', `tx:cancel:${tempId}`);
}

function dirKb(tempId: string) {
  return new InlineKeyboard()
    .text('Метанойя', `tx:clarify:direction:metanoia:${tempId}`)
    .text('Курс ДПО', `tx:clarify:direction:course_dpo:${tempId}`);
}

function entityKb(tempId: string) {
  return new InlineKeyboard()
    .text('ИП', `tx:clarify:entity:ip_eremyan:${tempId}`)
    .text('ООО', `tx:clarify:entity:ooo_assurgina:${tempId}`)
    .row()
    .text('Личное', `tx:clarify:entity:personal:${tempId}`);
}

function editFieldKb(tempId: string) {
  return new InlineKeyboard()
    .text('💰 Сумма', `tx:editfield:amount:${tempId}`)
    .text('🏢 Юрлицо', `tx:editfield:entity:${tempId}`)
    .row()
    .text('📁 Направление', `tx:editfield:direction:${tempId}`)
    .text('📦 Категория', `tx:editfield:category:${tempId}`)
    .row()
    .text('💳 Источник', `tx:editfield:source:${tempId}`)
    .text('📝 Описание', `tx:editfield:description:${tempId}`)
    .row()
    .text('✅ Готово', `tx:confirm:${tempId}`);
}

// ─── Главные хендлеры ──────────────────────────────────────

export async function handleTextMessage(ctx: BotContextWithSession): Promise<void> {
  const text = ctx.message?.text ?? '';
  if (text.startsWith('/')) return;
  await processInput(ctx, text, undefined);
}

export async function handleVoiceMessage(ctx: BotContextWithSession): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;

  if (voice.duration > 60) {
    await ctx.reply('⚠️ Голосовое слишком длинное (макс. 1 минута). Опишите коротко или напишите текстом.');
    return;
  }

  let audioBase64: string;
  try {
    const file = await ctx.api.getFile(voice.file_id);
    const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path ?? ''}`;
    const resp = await fetch(url);
    audioBase64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id }, 'voice_download_error');
    await ctx.reply('❌ Не удалось загрузить голосовое. Напишите текстом.');
    return;
  }

  await processInput(ctx, undefined, audioBase64);
}

export async function handleDocumentMessage(ctx: BotContextWithSession): Promise<void> {
  const session = await ctx.session.get();
  if (session?.state === 'awaiting_statement_file') {
    await handleImportFile(ctx);
    return;
  }
  await ctx.reply('📎 Для загрузки файла выписки используйте команду /import');
}

async function processInput(ctx: BotContextWithSession, text: string | undefined, audioBase64: string | undefined): Promise<void> {
  const user = ctx.user;
  const telegramId = BigInt(ctx.from!.id);
  const start = Date.now();

  // Проверить активную FSM-сессию
  const session = await ctx.session.get();
  if (session?.state === 'awaiting_manual_input') {
    await handleManualInput(ctx, text ?? '');
    return;
  }
  if (session?.state === 'awaiting_edit_field') {
    await handleEditFieldInput(ctx, text ?? '', session.context);
    return;
  }
  if (session?.state === 'awaiting_custom_percentages') {
    await handleCustomPercentInput(ctx, text ?? '', session.context);
    return;
  }
  if (session?.state === 'awaiting_setting_value') {
    await handleSettingValueInput(ctx, text ?? '', session.context);
    return;
  }

  const loadingMsg = await ctx.reply('⏳ Думаю...');

  try {
    const result = await classify({
      telegramId: user.telegramId,
      text,
      audioBase64,
      userRole: user.role,
      managerDirections: user.managerDirections,
      currentDate: todayMSK(),
    });

    if (result.fallback) {
      await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
        '⚠️ AI временно недоступен\\. Запишите вручную:\n' +
        '`сумма / юрлицо / направление / категория / описание`\n\n' +
        'Пример: `25000 / ИП / Метанойя / Видеопроизводство / Оплата оператору`',
        { parse_mode: 'MarkdownV2' }
      );
      await ctx.session.set('awaiting_manual_input', {});
      return;
    }

    // Проверка прав manager по направлению
    if (user.role === 'manager' && result.directionCode) {
      const dirRow = await sql<{ id: string }[]>`SELECT id FROM directions WHERE code = ${result.directionCode}`;
      const dirId = dirRow[0]?.id;
      const allowed = user.managerDirections ?? [];
      if (dirId && !allowed.includes(dirId)) {
        const userRow = await sql<{ id: string }[]>`SELECT id FROM app_users WHERE telegram_id = ${telegramId}`;
        const userId = userRow[0]?.id ?? '';
        const refs = await lookupRefs(result);
        if (refs.sourceId && refs.entityId) {
          await createTransaction({
            flowType: result.type,
            amount: result.amount,
            currency: result.currency,
            amountRub: result.amountRub,
            fxRate: result.fxRate,
            entityId: refs.entityId,
            directionId: refs.directionId,
            categoryId: refs.categoryId,
            sourceId: refs.sourceId,
            occurredAt: result.occurredAt,
            description: result.description,
            createdBy: userId,
            needsOwnerReview: true,
            aiConfidence: result.confidence,
          });
        }
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          `⚠️ Я определила направление как «${result.directionCode === 'course_dpo' ? 'Курс ДПО' : 'Метанойя'}». ` +
          `У вас нет прав на запись по этому направлению. Запись передана собственнику.`
        );
        return;
      }
    }

    const refs = await lookupRefs(result);
    const tempId = `${telegramId}_${Date.now()}`;

    // Сохраняем pending в сессию
    const pendingData = {
      tempId,
      result: serializeBigInt(result),
      refs,
    };

    const card = buildCard(result, refs.entityName, refs.dirName, refs.catName, refs.sourceName);

    if (result.confidence >= 0.85) {
      await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, card, {
        parse_mode: 'MarkdownV2',
        reply_markup: confirmKb(tempId),
      });
      await ctx.session.set('awaiting_confirmation', pendingData);
    } else if (result.confidence >= 0.7) {
      const unclear = result.needsClarification[0];
      await ctx.session.set('awaiting_clarification', { ...pendingData, pendingFields: result.needsClarification });
      if (unclear === 'direction') {
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          '🤔 Уточните: это расход по Метанойе или по Курсу ДПО?',
          { reply_markup: dirKb(tempId) }
        );
      } else if (unclear === 'entity') {
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          '🤔 С какого юрлица — ИП, ООО или личное?',
          { reply_markup: entityKb(tempId) }
        );
      } else {
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, card, {
          parse_mode: 'MarkdownV2',
          reply_markup: confirmKb(tempId),
        });
        await ctx.session.set('awaiting_confirmation', pendingData);
      }
    } else {
      // Low confidence — задать первый вопрос
      const unclear = result.needsClarification[0];
      await ctx.session.set('awaiting_clarification', { ...pendingData, pendingFields: result.needsClarification });
      if (unclear === 'direction') {
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          '🤔 Не уверена насчёт направления. Это Метанойя или Курс ДПО?',
          { reply_markup: dirKb(tempId) }
        );
      } else if (unclear === 'entity') {
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
          '🤔 Не уверена насчёт юрлица. ИП, ООО или личное?',
          { reply_markup: entityKb(tempId) }
        );
      } else {
        await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id, card, {
          parse_mode: 'MarkdownV2',
          reply_markup: confirmKb(tempId),
        });
        await ctx.session.set('awaiting_confirmation', pendingData);
      }
    }
  } catch (err) {
    log.error({ err, telegram_id: telegramId.toString(), latency_ms: Date.now() - start }, 'add_error');
    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
      '❌ Ошибка при обработке. Попробуйте ещё раз или напишите в формате:\n`сумма / юрлицо / направление / категория`',
      { parse_mode: 'Markdown' }
    );
  }
}

// ─── Ручной ввод ───────────────────────────────────────────

async function handleManualInput(ctx: BotContextWithSession, text: string): Promise<void> {
  const parts = text.split('/').map(s => s.trim());
  if (parts.length < 4) {
    await ctx.reply('⚠️ Формат: `сумма / юрлицо / направление / категория / описание`', { parse_mode: 'Markdown' });
    return;
  }
  const [rawAmt, rawEntity, rawDir, rawCat, ...descParts] = parts;

  try {
    const amountKopecks = toKopecks(rawAmt ?? '0');
    const entityMap: Record<string, string> = { 'ип': 'ip_eremyan', 'ооо': 'ooo_assurgina', 'личное': 'personal' };
    const entityCode = entityMap[(rawEntity ?? '').toLowerCase()] ?? 'ip_eremyan';
    const dirMap: Record<string, string> = { 'дпо': 'course_dpo', 'метанойя': 'metanoia', 'метанойа': 'metanoia', 'общее': 'common' };
    const dirCode = dirMap[(rawDir ?? '').toLowerCase()];

    const [entityRow, dirRow, catRow, srcRow, userRow] = await Promise.all([
      sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM entities WHERE code = ${entityCode}`,
      dirCode ? sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM directions WHERE code = ${dirCode}` : Promise.resolve([]),
      sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM categories WHERE LOWER(display_name) LIKE LOWER(${'%' + (rawCat ?? '') + '%'}) AND is_active = true LIMIT 1`,
      sql<{ id: string }[]>`SELECT id FROM sources WHERE code = 'rs_ip'`,
      sql<{ id: string }[]>`SELECT id FROM app_users WHERE telegram_id = ${BigInt(ctx.from!.id)}`,
    ]);

    if (!entityRow[0] || !srcRow[0] || !userRow[0]) throw new Error('refs missing');

    const tx = await createTransaction({
      flowType: 'expense',
      amount: amountKopecks,
      currency: 'RUB',
      amountRub: amountKopecks,
      entityId: entityRow[0].id,
      directionId: dirRow[0]?.id ?? null,
      categoryId: catRow[0]?.id ?? null,
      sourceId: srcRow[0].id,
      occurredAt: todayMSK(),
      description: descParts.join(' / ') || null,
      createdBy: userRow[0].id,
    });

    await ctx.session.clear();
    await ctx.reply(
      `✅ Записано вручную.\n💰 ${rubles(amountKopecks)}\n🏢 ${entityRow[0].display_name}` +
      (dirRow[0] ? `\n📁 ${dirRow[0].display_name}` : '') +
      (catRow[0] ? `\n📦 ${catRow[0].display_name}` : '') +
      (descParts.length ? `\n📝 ${descParts.join(' / ')}` : '')
    );

    // Проверить порог для фондов
    if (ctx.user.role === 'owner') {
      const proposal = await proposeAllocation(tx.id);
      if (proposal) {
        const lines = proposal.proposed.map(p => `• ${p.fundCode}: ${rubles(p.amountKopecks)}`).join('\n');
        await ctx.reply(`💰 Крупное поступление — распределить по фондам?\n${lines}`,
          { reply_markup: new InlineKeyboard().text('✅ Распределить', `dist:execute:${tx.id}`).text('⏭ Пропустить', `dist:skip:${tx.id}`) }
        );
      }
    }
  } catch {
    await ctx.reply('⚠️ Не удалось разобрать. Проверьте формат: `сумма / юрлицо / направление / категория`', { parse_mode: 'Markdown' });
  }
}

async function handleEditFieldInput(ctx: BotContextWithSession, value: string, context: Record<string, unknown>): Promise<void> {
  const field = context['editField'] as string;
  const tempId = context['tempId'] as string;
  const result = context['result'] as Record<string, unknown>;
  const refs = context['refs'] as Record<string, string | null>;

  if (field === 'description') {
    result['description'] = value;
  } else if (field === 'amount') {
    try { result['amount'] = toKopecks(value).toString(); result['amountRub'] = result['amount']; } catch { await ctx.reply('⚠️ Неверная сумма.'); return; }
  }

  await ctx.session.set('awaiting_confirmation', { tempId, result, refs });
  const rebuilt = rebuildResult(result);
  const card = buildCard(rebuilt, refs['entityName'] ?? '', refs['dirName'] ?? '', refs['catName'] ?? '', refs['sourceName'] ?? '');
  await ctx.reply(card, { parse_mode: 'MarkdownV2', reply_markup: confirmKb(tempId) });
}

// ─── Callback handler ─────────────────────────────────────

export async function handleTxCallback(ctx: BotContextWithSession): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const parts = data.split(':');
  const action = parts[1];

  await ctx.answerCallbackQuery().catch(() => {});

  if (action === 'confirm') {
    await savePendingTransaction(ctx);
  } else if (action === 'cancel') {
    await ctx.session.clear();
    await ctx.editMessageText('❌ Отменено.').catch(() => ctx.reply('❌ Отменено.'));
  } else if (action === 'edit') {
    const tempId = parts.slice(2).join(':');
    await ctx.editMessageReplyMarkup({ reply_markup: editFieldKb(tempId) }).catch(() => {});
  } else if (action === 'editfield') {
    const [, , field, ...rest] = parts;
    const tempId = rest.join(':');
    const session = await ctx.session.get();
    if (session) {
      await ctx.session.set('awaiting_edit_field', { ...session.context, editField: field, tempId });
    }
    const prompts: Record<string, string> = {
      amount: 'Введите новую сумму (например: 25000):',
      description: 'Введите новое описание:',
      direction: '📁 Направление:',
      entity: '🏢 Юрлицо:',
    };
    await ctx.editMessageText(prompts[field ?? ''] ?? 'Введите значение:').catch(() => {});
    if (field === 'direction') {
      await ctx.reply('Выберите направление:', { reply_markup: dirKb(tempId) });
    } else if (field === 'entity') {
      await ctx.reply('Выберите юрлицо:', { reply_markup: entityKb(tempId) });
    }
  } else if (action === 'clarify') {
    const [, , field, value, ...rest] = parts;
    const tempId = rest.join(':');
    await applyClarification(ctx, field ?? '', value ?? '', tempId);
  }
}

async function applyClarification(ctx: BotContextWithSession, field: string, value: string, tempId: string): Promise<void> {
  const session = await ctx.session.get();
  if (!session) return;

  const result = { ...(session.context['result'] as Record<string, unknown>) };
  if (field === 'direction') result['directionCode'] = value;
  if (field === 'entity') result['entityCode'] = value;

  // Перезагрузить refs для обновлённых кодов
  const rebuilt = rebuildResult(result);
  const refs = await lookupRefs(rebuilt);

  const pendingFields = (session.context['pendingFields'] as string[] | undefined) ?? [];
  const remaining = pendingFields.filter(f => f !== field);

  if (remaining.length > 0) {
    await ctx.session.set('awaiting_clarification', { tempId, result, refs, pendingFields: remaining });
    const next = remaining[0];
    if (next === 'direction') {
      await ctx.editMessageText('🤔 Направление — Метанойя или Курс ДПО?', { reply_markup: dirKb(tempId) }).catch(() => {});
    } else {
      const card = buildCard(rebuilt, refs.entityName, refs.dirName, refs.catName, refs.sourceName);
      await ctx.editMessageText(card, { parse_mode: 'MarkdownV2', reply_markup: confirmKb(tempId) }).catch(() => {});
    }
  } else {
    await ctx.session.set('awaiting_confirmation', { tempId, result, refs });
    const card = buildCard(rebuilt, refs.entityName, refs.dirName, refs.catName, refs.sourceName);
    await ctx.editMessageText(card, { parse_mode: 'MarkdownV2', reply_markup: confirmKb(tempId) }).catch(() => {});
  }
}

async function savePendingTransaction(ctx: BotContextWithSession): Promise<void> {
  const session = await ctx.session.get();
  if (!session?.context['result']) {
    await ctx.editMessageText('⚠️ Сессия истекла. Попробуйте снова.').catch(() => {});
    return;
  }

  const result = session.context['result'] as Record<string, unknown>;
  const refs = session.context['refs'] as Record<string, string | null | undefined>;

  try {
    const userRow = await sql<{ id: string }[]>`SELECT id FROM app_users WHERE telegram_id = ${BigInt(ctx.from!.id)}`;
    const userId = userRow[0]?.id ?? '';

    if (!refs['sourceId'] || !refs['entityId']) {
      await ctx.editMessageText('⚠️ Не определён источник или юрлицо. Запишите вручную.').catch(() => {});
      await ctx.session.clear();
      return;
    }

    const amountRub = BigInt(result['amountRub'] as string);
    const amount = BigInt(result['amount'] as string);

    const tx = await createTransaction({
      flowType: result['type'] as 'income' | 'expense',
      amount,
      currency: result['currency'] as 'RUB',
      amountRub,
      fxRate: result['fxRate'] as number | null,
      entityId: refs['entityId'] as string,
      directionId: refs['directionId'] as string | null,
      categoryId: refs['categoryId'] as string | null,
      sourceId: refs['sourceId'] as string,
      occurredAt: result['occurredAt'] as string,
      description: result['description'] as string | null,
      createdBy: userId,
      aiConfidence: result['confidence'] as number | null,
    });

    await ctx.session.clear();
    const icon = result['type'] === 'expense' ? 'Расход' : 'Поступление';
    let msg = `✅ Записано. ${icon}: ${rubles(amountRub)}`;

    if (result['type'] === 'income' && ctx.user.role === 'owner') {
      const proposal = await proposeAllocation(tx.id);
      if (proposal) {
        const lines = proposal.proposed.map(p => `• ${p.fundCode}: ${rubles(p.amountKopecks)} (${p.percentage}%)`).join('\n');
        await ctx.editMessageText(`${msg}\n\n💰 Крупное поступление — распределить по фондам?\n${lines}`, {
          reply_markup: new InlineKeyboard().text('✅ Распределить', `dist:execute:${tx.id}`).text('⏭ Пропустить', `dist:skip:${tx.id}`),
        }).catch(() => {});
        return;
      }
    }

    await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id }, 'save_transaction_error');
    await ctx.editMessageText('❌ Ошибка при сохранении. Попробуйте снова.').catch(() => {});
  }
}

// ─── Хелперы ───────────────────────────────────────────────

function serializeBigInt(obj: unknown): unknown {
  return JSON.parse(JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
}

function rebuildResult(raw: Record<string, unknown>): ClassificationResult {
  return {
    fallback: false,
    type: raw['type'] as 'income' | 'expense',
    amount: BigInt(raw['amount'] as string),
    currency: raw['currency'] as 'RUB',
    amountRub: BigInt(raw['amountRub'] as string),
    fxRate: raw['fxRate'] as number | null,
    entityCode: raw['entityCode'] as 'ip_eremyan',
    directionCode: raw['directionCode'] as 'metanoia' | null,
    categoryCode: raw['categoryCode'] as string | null,
    sourceCode: raw['sourceCode'] as string | null,
    occurredAt: raw['occurredAt'] as string,
    description: raw['description'] as string | null,
    confidence: raw['confidence'] as number,
    needsClarification: (raw['needsClarification'] as ClassificationResult['needsClarification']) ?? [],
    rawTranscript: raw['rawTranscript'] as string | null,
  };
}
