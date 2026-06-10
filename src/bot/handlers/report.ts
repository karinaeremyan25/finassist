import type { BotContextWithSession } from '../middleware/session.js';
import { reportDirectionKeyboard, reportPeriodKeyboard } from '../keyboards/reportPeriod.js';
import { InlineKeyboard } from 'grammy';
import { calculatePnL, formatPnLMessage } from '../../services/analytics.js';
import { sql } from '../../db/client.js';
import {
  getCurrentMonthPeriod, getLastMonthPeriod,
  getCurrentQuarterPeriod, getYTDPeriod, parsePeriod,
} from '../../utils/dates.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'report' });

export async function handleReport(ctx: BotContextWithSession): Promise<void> {
  const start = Date.now();
  try {
    const directions = await sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM directions WHERE is_active = true ORDER BY code ASC
    `;

    const keyboard = reportDirectionKeyboard(directions.map(d => ({ id: d.id, displayName: d.display_name })));
    await ctx.reply('📊 Какой отчёт показать?\n\nНаправление:', { reply_markup: keyboard });
    log.info({ telegram_id: ctx.from?.id, latency_ms: Date.now() - start }, 'report_ok');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id, latency_ms: Date.now() - start }, 'report_error');
    throw err;
  }
}

export async function handleReportCallback(ctx: BotContextWithSession): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  await ctx.answerCallbackQuery().catch(() => {});

  if (data.startsWith('report:direction:')) {
    const dirId = data.replace('report:direction:', '');
    await ctx.session.set('report_period', { directionId: dirId === 'all' ? null : dirId });
    await ctx.editMessageText('📅 За какой период?', { reply_markup: reportPeriodKeyboard() }).catch(() => {});

  } else if (data.startsWith('report:period:')) {
    const periodCode = data.replace('report:period:', '');
    const session = await ctx.session.get();
    const directionId = (session?.context['directionId'] as string | null) ?? null;

    if (periodCode === 'custom') {
      await ctx.session.set('report_custom_period', { directionId });
      await ctx.editMessageText(
        '📆 Введите период в формате `YYYY-MM-DD — YYYY-MM-DD`\nНапример: `2026-04-01 — 2026-04-30`',
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    const period = getPeriodByCode(periodCode);
    if (!period) { await ctx.reply('⚠️ Неизвестный период.'); return; }

    await buildAndSendReport(ctx, directionId, period.dateFrom, period.dateTo);

  } else if (data === 'report:change_period') {
    await ctx.editMessageText('📅 Выберите период:', { reply_markup: reportPeriodKeyboard() }).catch(() => {});

  } else if (data === 'report:change_direction') {
    const directions = await sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM directions WHERE is_active = true ORDER BY code ASC
    `;
    const keyboard = reportDirectionKeyboard(directions.map(d => ({ id: d.id, displayName: d.display_name })));
    await ctx.editMessageText('📁 Выберите направление:', { reply_markup: keyboard }).catch(() => {});
  }
}

function getPeriodByCode(code: string): { dateFrom: string; dateTo: string } | null {
  if (code === 'this_month') return getCurrentMonthPeriod();
  if (code === 'last_month') return getLastMonthPeriod();
  if (code === 'this_quarter') return getCurrentQuarterPeriod();
  if (code === 'ytd') return getYTDPeriod();
  return parsePeriod(code);
}

async function buildAndSendReport(
  ctx: BotContextWithSession,
  directionId: string | null,
  dateFrom: string,
  dateTo: string
): Promise<void> {
  const loadingText = '⏳ Считаю...';
  try {
    await ctx.editMessageText(loadingText).catch(() => {});
  } catch { /* ignore */ }

  try {
    const pnl = await calculatePnL({
      directionId,
      dateFrom,
      dateTo,
      viewerUserId: ctx.user.id,
      viewerRole: ctx.user.role as 'owner',
    });

    const text = formatPnLMessage(pnl);
    const actions = new InlineKeyboard()
      .text('📅 Сменить период', 'report:change_period')
      .text('📁 Сменить направление', 'report:change_direction')
      .row()
      .text('🏠 В меню', 'nav:main');

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: actions }).catch(
      () => ctx.reply(text, { parse_mode: 'Markdown', reply_markup: actions })
    );
    await ctx.session.clear();
  } catch (err: unknown) {
    log.error({ err, telegram_id: ctx.from?.id }, 'report_calc_error');
    await ctx.editMessageText('❌ Ошибка при формировании отчёта. Попробуйте снова.').catch(() => {});
  }
}
