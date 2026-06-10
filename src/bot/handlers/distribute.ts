import { InlineKeyboard } from 'grammy';
import type { BotContextWithSession } from '../middleware/session.js';
import { distributeConfirmKeyboard } from '../keyboards/fundActions.js';
import { getUndistributedTransactions } from '../../db/repositories/funds.js';
import { proposeAllocation, executeAllocation } from '../../services/funds.js';
import { rubles } from '../../utils/money.js';
import { sql } from '../../db/client.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'distribute' });

const FUND_LABEL: Record<string, string> = {
  tax: '🏛 Налоговый',
  reserve: '🛡 Резервный',
  development: '🚀 Развитие',
  personal: '👤 Личный',
};

async function getEntityName(entityId: string): Promise<string> {
  const rows = await sql<{ display_name: string }[]>`
    SELECT display_name FROM entities WHERE id = ${entityId}
  `;
  return rows[0]?.display_name ?? entityId;
}

async function showDistributeCard(
  ctx: BotContextWithSession,
  txId: string,
  remaining: number,
  edit: boolean
): Promise<void> {
  const [proposal, txs] = await Promise.all([
    proposeAllocation(txId),
    getUndistributedTransactions(),
  ]);

  const tx = txs.find((t) => t.id === txId);
  const entityName = tx ? await getEntityName(tx.entityId) : '';
  const date = tx?.occurredAt ?? '';
  const desc = tx?.description ?? '';
  const amountKopecks = proposal?.amountKopecks ?? tx?.amountRub ?? 0n;

  let text = `💰 *Распределение поступления*\n\n`;
  text += `Сумма: *${rubles(amountKopecks)}*\n`;
  text += `Дата: ${date}\n`;
  if (entityName) text += `Юрлицо: ${entityName}\n`;
  if (desc) text += `Описание: ${desc}\n`;

  if (proposal) {
    const fundLines = proposal.proposed
      .map((p) => `• ${FUND_LABEL[p.fundCode] ?? p.fundCode}: ${p.percentage}% = *${rubles(p.amountKopecks)}*`)
      .join('\n');
    text += `\n📊 *Предложение:*\n${fundLines}`;
  } else {
    text += `\n_Сумма ниже порога автораспределения._`;
  }

  text += `\n\n_Осталось: ${remaining}_`;

  const keyboard = distributeConfirmKeyboard(txId);

  if (edit) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(
      () => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
    );
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

export async function handleDistribute(ctx: BotContextWithSession): Promise<void> {
  const telegramId = ctx.from?.id;
  const start = Date.now();

  try {
    const txs = await getUndistributedTransactions();

    if (txs.length === 0) {
      await ctx.reply('✅ Нет поступлений для распределения.', {
        reply_markup: new InlineKeyboard().text('🏠 В меню', 'nav:main'),
      });
      log.info({ telegram_id: telegramId, latency_ms: Date.now() - start }, 'distribute_empty');
      return;
    }

    await showDistributeCard(ctx, txs[0]!.id, txs.length, false);
    log.info({ telegram_id: telegramId, count: txs.length, latency_ms: Date.now() - start }, 'distribute_ok');
  } catch (err) {
    log.error({ err, telegram_id: telegramId, latency_ms: Date.now() - start }, 'distribute_error');
    throw err;
  }
}

export async function handleDistCallback(ctx: BotContextWithSession): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const data = ctx.callbackQuery?.data ?? '';
  const start = Date.now();

  try {
    if (data.startsWith('dist:execute:')) {
      const txId = data.replace('dist:execute:', '');
      const proposal = await proposeAllocation(txId);

      if (!proposal) {
        await ctx.editMessageText(
          'ℹ️ Поступление ниже порога автораспределения. Пропускаем.',
          { reply_markup: new InlineKeyboard().text('🏠 В меню', 'nav:main') }
        ).catch(() => {});
      } else {
        await executeAllocation(proposal, undefined, ctx.user.id);
        const remaining = await getUndistributedTransactions();
        if (remaining.length === 0) {
          await ctx.editMessageText('✅ Все поступления распределены!', {
            reply_markup: new InlineKeyboard()
              .text('💼 Фонды', 'fund:history')
              .text('🏠 В меню', 'nav:main'),
          }).catch(() => {});
        } else {
          await showDistributeCard(ctx, remaining[0]!.id, remaining.length, true);
        }
      }

    } else if (data.startsWith('dist:custom:')) {
      const txId = data.replace('dist:custom:', '');
      await ctx.session.set('awaiting_custom_percentages', { txId });
      await ctx.editMessageText(
        '✏️ Введите проценты в формате:\n`налог/резерв/развитие`\n\nНапример: `6/10/15`\n\n_Личный фонд — остаток до 100%._',
        { parse_mode: 'Markdown' }
      ).catch(() => {});

    } else if (data.startsWith('dist:skip:')) {
      const txId = data.replace('dist:skip:', '');
      const txs = await getUndistributedTransactions();
      const remaining = txs.filter((t) => t.id !== txId);
      if (remaining.length === 0) {
        await ctx.editMessageText('✅ Больше поступлений для распределения нет.', {
          reply_markup: new InlineKeyboard().text('🏠 В меню', 'nav:main'),
        }).catch(() => {});
      } else {
        await showDistributeCard(ctx, remaining[0]!.id, remaining.length, true);
      }
    }

    log.info({ telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'dist_callback_ok');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'dist_callback_error');
    throw err;
  }
}

/**
 * Обрабатывает ввод кастомных процентов распределения.
 * Вызывается из processInput в add.ts при session.state === 'awaiting_custom_percentages'.
 */
export async function handleCustomPercentInput(
  ctx: BotContextWithSession,
  text: string,
  context: Record<string, unknown>
): Promise<void> {
  const txId = context['txId'] as string;
  const parts = text.split('/').map((s) => s.trim());

  if (parts.length < 3) {
    await ctx.reply('❌ Формат: `налог/резерв/развитие` (например: `6/10/15`)', {
      parse_mode: 'Markdown',
    });
    return;
  }

  const tax = parseFloat(parts[0] ?? '');
  const reserve = parseFloat(parts[1] ?? '');
  const development = parseFloat(parts[2] ?? '');

  if ([tax, reserve, development].some((n) => isNaN(n) || n < 0)) {
    await ctx.reply('❌ Введите положительные числа. Формат: `6/10/15`', { parse_mode: 'Markdown' });
    return;
  }

  const personal = 100 - tax - reserve - development;
  if (personal < 0) {
    await ctx.reply('❌ Сумма процентов не может превышать 100%.');
    return;
  }

  const proposal = await proposeAllocation(txId);
  if (!proposal) {
    await ctx.reply('⚠️ Поступление не найдено. Попробуйте /distribute снова.');
    await ctx.session.clear();
    return;
  }

  await executeAllocation(proposal, { tax, reserve, development }, ctx.user.id);
  await ctx.session.clear();

  await ctx.reply(
    `✅ *Распределено:*\n` +
      `🏛 Налоговый: ${tax}%\n` +
      `🛡 Резервный: ${reserve}%\n` +
      `🚀 Развитие: ${development}%\n` +
      `👤 Личный: ${personal.toFixed(2)}%`,
    { parse_mode: 'Markdown' }
  );

  log.info(
    { telegram_id: ctx.from?.id, txId, tax, reserve, development },
    'custom_percent_applied'
  );
}
