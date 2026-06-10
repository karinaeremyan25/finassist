import { InlineKeyboard } from 'grammy';
import type { BotContextWithSession } from '../middleware/session.js';
import { fundMainKeyboard } from '../keyboards/fundActions.js';
import { getAllFundBalances } from '../../services/funds.js';
import { getMiniAppFinancialOverview } from '../../services/miniApp.js';
import { rubles } from '../../utils/money.js';
import { sql } from '../../db/client.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'funds' });

const FUND_EMOJI: Record<string, string> = {
  tax: '🏛',
  reserve: '🛡',
  development: '🚀',
  personal: '👤',
};

export async function handleFunds(ctx: BotContextWithSession): Promise<void> {
  const telegramId = ctx.from?.id;
  const start = Date.now();

  try {
    const balances = await getAllFundBalances();
    const overview = await getMiniAppFinancialOverview();

    const lines = balances.map((b) => {
      const emoji = FUND_EMOJI[b.code] ?? '💰';
      return `${emoji} *${b.displayName}* (${b.defaultPercentage}%): ${rubles(b.balanceKopecks)}`;
    });

    const taxFund = balances.find((b) => b.code === 'tax');
    let alertText = '';
    if (taxFund && taxFund.balanceKopecks < 0n) {
      alertText = '\n\n⚠️ *ВНИМАНИЕ:* Налоговый фонд отрицательный! Срочно пополните.';
    }

    const extraLines = [
      `*Фонд благодарность* (${overview.gratitudeFund.label}): ${rubles(
        overview.gratitudeFund.amountKopecks
      )} — ${overview.gratitudeFund.count} операций`,
      `*Кредиты мужа*: ${rubles(overview.loanBurden.loanExpenseKopecks)} (${overview.loanBurden.ratioPercent?.toFixed(1) ?? '-'}% от выручки; цель ${overview.loanBurden.targetPercent}%)`,
      `*Налоговый фонд*: ${rubles(overview.taxReminder.currentTaxFundKopecks)} — ${
        overview.taxReminder.isUnderfunded ? '⚠️ требуется пополнение' : 'OK'
      }`,
      `*ФОТ + налоговые расходы*: ${overview.fundOptimization.fotSharePercent?.toFixed(1) ?? '-'}% от выручки`,
    ];

    const text =
      '💼 *Балансы фондов*\n\n' +
      lines.join('\n') +
      '\n\n' +
      extraLines.join('\n') +
      alertText;

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: fundMainKeyboard() });

    log.info({ telegram_id: telegramId, latency_ms: Date.now() - start }, 'funds_ok');
  } catch (err) {
    log.error({ err, telegram_id: telegramId, latency_ms: Date.now() - start }, 'funds_error');
    throw err;
  }
}

export async function handleFundCallback(ctx: BotContextWithSession): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const data = ctx.callbackQuery?.data ?? '';
  const start = Date.now();

  try {
    if (data === 'fund:distribute') {
      await ctx.reply('💰 Используйте /distribute для распределения поступлений.');

    } else if (data === 'fund:history') {
      const rows = await sql<{
        fund_name: string;
        amount: bigint;
        type: string;
        occurred_at: string;
      }[]>`
        SELECT f.display_name AS fund_name,
               ft.amount,
               ft.fund_transaction_type AS type,
               ft.occurred_at::text
        FROM fund_transactions ft
        JOIN funds f ON f.id = ft.fund_id
        ORDER BY ft.created_at DESC
        LIMIT 10
      `;

      if (rows.length === 0) {
        await ctx.reply('📊 Движений по фондам ещё нет.');
        return;
      }

      const lines = rows.map((r) => {
        const sign = r.amount >= 0n ? '+' : '';
        return `${r.occurred_at.slice(0, 10)} | ${r.fund_name}: ${sign}${rubles(r.amount)}`;
      });

      await ctx.reply('📊 *Последние движения по фондам:*\n\n' + lines.join('\n'), {
        parse_mode: 'Markdown',
      });

    } else if (data === 'fund:settings') {
      await ctx.reply('⚙️ Используйте /settings для настройки фондов.');
    }

    log.info({ telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'fund_callback_ok');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'fund_callback_error');
    throw err;
  }
}
