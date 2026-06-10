import { InlineKeyboard } from 'grammy';
import type { BotContextWithSession } from '../middleware/session.js';
import {
  getUnverifiedTransactions,
  verifyTransaction,
  softDeleteTransaction,
} from '../../db/repositories/transactions.js';
import { sql } from '../../db/client.js';
import { rubles } from '../../utils/money.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'verify' });

async function resolveNames(
  entityId: string,
  directionId: string | null,
  categoryId: string | null
): Promise<{ entityName: string; directionName: string | null; categoryName: string | null }> {
  const [eRows, dRows, cRows] = await Promise.all([
    sql<{ display_name: string }[]>`SELECT display_name FROM entities WHERE id = ${entityId}`,
    directionId
      ? sql<{ display_name: string }[]>`SELECT display_name FROM directions WHERE id = ${directionId}`
      : Promise.resolve([] as { display_name: string }[]),
    categoryId
      ? sql<{ display_name: string }[]>`SELECT display_name FROM categories WHERE id = ${categoryId}`
      : Promise.resolve([] as { display_name: string }[]),
  ]);
  return {
    entityName: eRows[0]?.display_name ?? entityId,
    directionName: dRows[0]?.display_name ?? null,
    categoryName: cRows[0]?.display_name ?? null,
  };
}

function verifyKeyboard(txId: string, skipOffset: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Подтвердить', `verify:approve:${txId}`)
    .text('🗑 Удалить', `verify:reject:${txId}`)
    .row()
    .text('⏭ Пропустить', `verify:skip:${skipOffset + 1}`)
    .text('🏠 В меню', 'nav:main');
}

async function showVerifyCard(
  ctx: BotContextWithSession,
  offset: number,
  edit: boolean
): Promise<void> {
  const txs = await getUnverifiedTransactions();
  const remaining = txs.slice(offset);

  if (remaining.length === 0) {
    const text =
      offset === 0
        ? '✅ Нераспознанных транзакций нет. Всё проверено!'
        : '✅ Больше транзакций нет. Список завершён.';
    const kb = new InlineKeyboard().text('🏠 В меню', 'nav:main');
    if (edit) {
      await ctx.editMessageText(text, { reply_markup: kb }).catch(() => ctx.reply(text, { reply_markup: kb }));
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

  const tx = remaining[0]!;
  const total = txs.length;
  const current = offset + 1;
  const { entityName, directionName, categoryName } = await resolveNames(
    tx.entityId,
    tx.directionId,
    tx.categoryId
  );

  const flowIcon = tx.flowType === 'income' ? '📥' : '📤';
  let text = `🔍 *Верификация ${current}/${total}*\n\n`;
  text += `${flowIcon} *${rubles(tx.amountRub)}*\n`;
  text += `📅 Дата: ${tx.occurredAt}\n`;
  text += `🏢 Юрлицо: ${entityName}\n`;
  if (directionName) text += `📁 Направление: ${directionName}\n`;
  if (categoryName) text += `📌 Категория: ${categoryName}\n`;
  if (tx.description) text += `📝 ${tx.description}\n`;
  if (tx.aiConfidence !== null) text += `🤖 AI: ${Math.round(tx.aiConfidence * 100)}%\n`;
  if (tx.needsClassification) text += `\n⚠️ _Требует классификации_`;

  const keyboard = verifyKeyboard(tx.id, offset);

  if (edit) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(
      () => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
    );
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

export async function handleVerify(ctx: BotContextWithSession): Promise<void> {
  const start = Date.now();
  try {
    await showVerifyCard(ctx, 0, false);
    log.info({ telegram_id: ctx.from?.id, latency_ms: Date.now() - start }, 'verify_ok');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id, latency_ms: Date.now() - start }, 'verify_error');
    throw err;
  }
}

export async function handleVerifyCallback(ctx: BotContextWithSession): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const data = ctx.callbackQuery?.data ?? '';
  const start = Date.now();

  try {
    if (data.startsWith('verify:approve:')) {
      const txId = data.replace('verify:approve:', '');
      await verifyTransaction(txId, ctx.user.id);
      await showVerifyCard(ctx, 0, true);

    } else if (data.startsWith('verify:reject:')) {
      const txId = data.replace('verify:reject:', '');
      await softDeleteTransaction(txId, ctx.user.id);
      await showVerifyCard(ctx, 0, true);

    } else if (data.startsWith('verify:skip:')) {
      const offsetStr = data.replace('verify:skip:', '');
      const offset = parseInt(offsetStr, 10);
      await showVerifyCard(ctx, isNaN(offset) ? 1 : offset, true);
    }

    log.info({ telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'verify_callback_ok');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'verify_callback_error');
    throw err;
  }
}
