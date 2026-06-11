import { InlineKeyboard } from 'grammy';
import type { BotContextWithSession } from '../middleware/session.js';
import { getAllSettings, setSetting } from '../../db/repositories/settings.js';
import { getAllActiveUsers } from '../../db/repositories/users.js';
import { rubles } from '../../utils/money.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'settings' });

const FUND_KEYS = [
  'fund_percentage_tax',
  'fund_percentage_reserve',
  'fund_percentage_development',
] as const;

const FUND_LABEL: Record<string, string> = {
  fund_percentage_tax: '🏛 Налоговый фонд (%)',
  fund_percentage_reserve: '🛡 Резервный фонд (%)',
  fund_percentage_development: '🚀 Фонд развития (%)',
};

function settingsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of FUND_KEYS) {
    kb.text(`✏️ ${FUND_LABEL[key]}`, `settings:edit:${key}`).row();
  }
  kb
    .text('✏️ Порог крупного поступления', 'settings:edit:large_income_threshold')
    .row()
    .text('👥 Пользователи', 'settings:users')
    .row()
    .text('🏠 В меню', 'nav:main');
  return kb;
}

async function buildSettingsText(): Promise<string> {
  // settings.value = TEXT в реальной схеме БД
  const s = await getAllSettings();

  const taxPct = parseFloat(s['fund_percentage_tax'] ?? '') || 6;
  const reservePct = parseFloat(s['fund_percentage_reserve'] ?? '') || 10;
  const devPct = parseFloat(s['fund_percentage_development'] ?? '') || 15;
  const personalPct = Math.max(0, 100 - taxPct - reservePct - devPct);
  const threshold = parseInt(s['large_income_threshold'] ?? '', 10) || 10_000_000;

  return (
    '⚙️ *Настройки FinAssist*\n\n' +
    '*Распределение фондов:*\n' +
    `• 🏛 Налоговый: ${taxPct}%\n` +
    `• 🛡 Резервный: ${reservePct}%\n` +
    `• 🚀 Развитие: ${devPct}%\n` +
    `• 👤 Личный: ${personalPct}% _(остаток)_\n\n` +
    `*Порог крупного поступления:* ${rubles(BigInt(threshold))}`
  );
}

export async function handleSettings(ctx: BotContextWithSession): Promise<void> {
  const telegramId = ctx.from?.id;
  const start = Date.now();

  try {
    const text = await buildSettingsText();
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: settingsKeyboard() });
    log.info({ telegram_id: telegramId, latency_ms: Date.now() - start }, 'settings_ok');
  } catch (err) {
    log.error({ err, telegram_id: telegramId, latency_ms: Date.now() - start }, 'settings_error');
    throw err;
  }
}

export async function handleSettingsCallback(ctx: BotContextWithSession): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const data = ctx.callbackQuery?.data ?? '';
  const start = Date.now();

  try {
    if (data.startsWith('settings:edit:')) {
      const key = data.replace('settings:edit:', '');
      const label =
        key === 'large_income_threshold'
          ? 'порог крупного поступления (в копейках, 10000000 = 100 000 ₽)'
          : (FUND_LABEL[key] ?? key);

      await ctx.session.set('awaiting_setting_value', { key, label });
      await ctx.editMessageText(
        `✏️ Введите новое значение:\n*${label}*`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});

    } else if (data === 'settings:users') {
      const users = await getAllActiveUsers();
      const roleLabel: Record<string, string> = {
        owner: 'собственник',
        accountant: 'бухгалтер',
        manager: 'менеджер',
      };
      const lines = users.map((u) => `• ${u.fullName} — ${roleLabel[u.role] ?? u.role}`);
      await ctx.editMessageText(
        '👥 *Активные пользователи:*\n\n' + (lines.join('\n') || '_Нет_'),
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard().text('← Назад', 'settings:back'),
        }
      ).catch(() => {});

    } else if (data === 'settings:back') {
      const text = await buildSettingsText();
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: settingsKeyboard(),
      }).catch(() => {});
    }

    log.info({ telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'settings_callback_ok');
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id, data, latency_ms: Date.now() - start }, 'settings_callback_error');
    throw err;
  }
}

export async function handleNavCallback(ctx: BotContextWithSession): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const data = ctx.callbackQuery?.data ?? '';

  if (data === 'nav:main') {
    await ctx.reply('🏠 Главное меню — используйте /start');
  }
}

/**
 * Обрабатывает ввод нового значения настройки.
 * Вызывается из processInput в add.ts при session.state === 'awaiting_setting_value'.
 */
export async function handleSettingValueInput(
  ctx: BotContextWithSession,
  text: string,
  context: Record<string, unknown>
): Promise<void> {
  const key = context['key'] as string;
  const label = context['label'] as string;

  const num = Number(text.trim().replace(',', '.'));
  if (isNaN(num) || num < 0) {
    await ctx.reply('❌ Введите корректное число.');
    return;
  }

  // value = TEXT в реальной схеме; updatedBy = telegram_id (bigint)
  await setSetting(key, String(num), ctx.user.telegramId);
  await ctx.session.clear();

  await ctx.reply(`✅ *${label}* обновлено: *${text.trim()}*`, { parse_mode: 'Markdown' });
  log.info({ telegram_id: ctx.from?.id, key, value: num }, 'setting_updated');
}
