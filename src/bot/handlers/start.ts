import type { BotContextWithSession } from '../middleware/session.js';
import { childLogger } from '../../utils/logger.js';
import { sql } from '../../db/client.js';
import { rubles } from '../../utils/money.js';
import { getCurrentMonthPeriod } from '../../utils/dates.js';

const log = childLogger({ handler: 'start' });

export async function handleStart(ctx: BotContextWithSession): Promise<void> {
  const user = ctx.user;
  const start = Date.now();

  try {
    if (user.role === 'owner') {
      await handleOwnerStart(ctx);
    } else if (user.role === 'accountant') {
      await handleAccountantStart(ctx);
    } else {
      await handleManagerStart(ctx);
    }
  } catch (err) {
    log.error({ err, telegram_id: ctx.from?.id, latency_ms: Date.now() - start }, 'start_error');
    throw err;
  }

  log.info({ telegram_id: ctx.from?.id, role: user.role, latency_ms: Date.now() - start }, 'start_ok');
}

async function handleOwnerStart(ctx: BotContextWithSession): Promise<void> {
  const { dateFrom, dateTo } = getCurrentMonthPeriod();

  const stats = await sql<{ count: string; profit: bigint }[]>`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN flow_type = 'income' THEN amount_rub ELSE -amount_rub END), 0)::bigint AS profit
    FROM transactions
    WHERE deleted_at IS NULL
      AND occurred_at >= ${dateFrom}
      AND occurred_at <= ${dateTo}
  `;

  const taxFund = await sql<{ balance: bigint }[]>`
    SELECT COALESCE(SUM(ft.amount), 0)::bigint AS balance
    FROM fund_transactions ft
    JOIN funds f ON f.id = ft.fund_id
    WHERE f.code = 'tax'
  `;

  const row = stats[0];
  const count = row?.count ?? '0';
  const profit = row?.profit ?? 0n;
  const taxBalance = taxFund[0]?.balance ?? 0n;

  const month = new Date(dateFrom).toLocaleString('ru', { month: 'long' });
  const year = new Date(dateFrom).getFullYear();
  const monthName = `${month} ${year}`;

  const esc = (s: string | number | bigint) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

  let taxLine = `🏛 Налоговый фонд: ${esc(rubles(taxBalance))}`;
  if (taxBalance < 0n) taxLine += ' ⚠️';

  const text =
    `👋 Привет, ${esc(ctx.user.fullName ?? 'друг')}\\!\n\n` +
    `Я твой финансовый ассистент\\. Помогаю вести учёт по двум юрлицам \\(ИП и ООО\\) и двум направлениям \\(Курс ДПО и Метанойя\\)\\.\n\n` +
    `*Что я умею:*\n` +
    `• Записать расход — просто напиши или скажи голосом\n` +
    `• Прибыль по направлению — /report\n` +
    `• Фонды — /funds\n` +
    `• Распределить поступление — /distribute\n` +
    `• Все команды — /help\n\n` +
    `*Сейчас \\(${esc(monthName)}\\):*\n` +
    `• Транзакций: ${esc(count)}\n` +
    `• Прибыль: ${esc(rubles(profit))}\n` +
    `• ${taxLine}`;

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

async function handleAccountantStart(ctx: BotContextWithSession): Promise<void> {
  const unverified = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM transactions
    WHERE verified = false AND deleted_at IS NULL
  `;
  const count = unverified[0]?.count ?? '0';

  const text =
    `👋 Здравствуйте, ${ctx.user.fullName}\\!\n\n` +
    `Этот бот ведёт учёт финансов Карины Еремян \\(ИП и ООО\\)\\. Ваша роль: бухгалтер\\.\n\n` +
    `*Что вам доступно:*\n` +
    `• /import — загрузить выписку Продамуса\n` +
    `• /verify — проверить и подтвердить транзакции\n` +
    `• /report — отчёты по направлениям\n` +
    `• /help — все команды\n\n` +
    `📋 Ожидают верификации: *${count}* транзакций`;

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

async function handleManagerStart(ctx: BotContextWithSession): Promise<void> {
  const { dateFrom, dateTo } = getCurrentMonthPeriod();
  const dirs = ctx.user.managerDirections ?? [];

  let expenseLine = '';
  if (dirs.length > 0) {
    const exp = await sql<{ amount: bigint; display_name: string }[]>`
      SELECT COALESCE(SUM(t.amount_rub), 0)::bigint AS amount, d.display_name
      FROM transactions t
      JOIN directions d ON d.id = t.direction_id
      WHERE t.direction_id = ANY(${dirs}::uuid[])
        AND t.flow_type = 'expense'
        AND t.deleted_at IS NULL
        AND t.occurred_at >= ${dateFrom}
        AND t.occurred_at <= ${dateTo}
      GROUP BY d.display_name
      LIMIT 1
    `;
    if (exp[0]) {
      expenseLine = `\n\n📊 Расходы ${exp[0].display_name}: ${rubles(exp[0].amount)}`;
    }
  }

  const dirNames = dirs.length > 0
    ? `Ваши направления определены в системе.`
    : `Ваши направления: не назначены. Обратитесь к Карине.`;

  const text =
    `👋 Здравствуйте, ${ctx.user.fullName}\\!\n\n` +
    `Этот бот ведёт учёт финансов Карины\\. Ваша роль: руководитель проекта\\.\n` +
    `${dirNames}\n\n` +
    `*Что вам доступно:*\n` +
    `• Записать расход — просто напишите или скажите голосом\n` +
    `• /report — отчёт по вашему направлению\n` +
    `• /help — все команды` +
    expenseLine;

  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

export async function handleHelp(ctx: BotContextWithSession): Promise<void> {
  const role = ctx.user.role;

  let text: string;
  if (role === 'owner') {
    text =
      `📚 *Команды*\n\n` +
      `📥 *Учёт*\n` +
      `• Просто напишите или скажите голосом — я запишу транзакцию\n\n` +
      `🏦 *Фонды*\n` +
      `• /funds — балансы фондов\n` +
      `• /distribute — распределить поступление\n\n` +
      `📊 *Аналитика*\n` +
      `• /report — отчёт по направлению/периоду\n\n` +
      `⚙️ *Управление*\n` +
      `• /settings — настройки\n` +
      `• /cancel — отменить текущий диалог`;
  } else if (role === 'accountant') {
    text =
      `📚 *Команды*\n\n` +
      `📥 *Импорт*\n` +
      `• /import — загрузить выписку Продамуса\n\n` +
      `📋 *Верификация*\n` +
      `• /verify — проверить транзакции\n\n` +
      `📊 *Аналитика*\n` +
      `• /report — отчёты\n\n` +
      `⚙️ *Прочее*\n` +
      `• /cancel — отменить текущий диалог`;
  } else {
    text =
      `📚 *Команды*\n\n` +
      `📥 *Учёт*\n` +
      `• Просто напишите или скажите голосом — я запишу расход\n\n` +
      `📊 *Аналитика*\n` +
      `• /report — отчёт по вашему направлению\n\n` +
      `⚙️ *Прочее*\n` +
      `• /cancel — отменить текущий диалог`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleCancel(ctx: BotContextWithSession): Promise<void> {
  await ctx.session.clear();
  await ctx.reply('✅ Диалог отменён.');
}
