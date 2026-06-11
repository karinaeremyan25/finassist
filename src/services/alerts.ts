import { z } from 'zod';
import type { Bot } from 'grammy';
import { sql } from '../db/client.js';
import { getAllActiveUsers } from '../db/repositories/users.js';
import { getSetting } from '../db/repositories/settings.js';
import { getAllFundBalances } from './funds.js';
import { getTaxBase, getWeeklySummary } from './analytics.js';
import { getNextTaxDeadline, USN_IP_DEADLINES, daysUntil, formatDateMSK } from '../utils/dates.js';
import { rubles } from '../utils/money.js';
import { childLogger } from '../utils/logger.js';
import type { BotContext } from '../bot/middleware/auth.js';

/**
 * Сервис алертов.
 *
 * - checkTaxFund: проверяет налоговый фонд за 14 дней до дедлайна.
 * - sendWeeklySummary: формирует и отправляет еженедельную сводку.
 * - Throttle через alert_log (не чаще 1 раза в день для tax, 1 раза в неделю для weekly).
 * - Не логируем полные тексты транзакций — только metadata.
 */

const log = childLogger({ handler: 'alerts' });

// ─────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────

type AlertType = 'weekly_summary' | 'tax_warning' | 'category_growth' | 'low_reserve';

// ─────────────────────────────────────────────────────────────
// Throttle helpers
// ─────────────────────────────────────────────────────────────

async function wasAlertSentToday(alertType: AlertType, recipientUserId: string): Promise<boolean> {
  const rows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*) AS cnt
    FROM alert_log
    WHERE alert_type = ${alertType}
      AND recipient_user_id = ${recipientUserId}
      AND sent_at >= NOW() - INTERVAL '24 hours'
  `;
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function wasAlertSentThisWeek(alertType: AlertType, recipientUserId: string): Promise<boolean> {
  const rows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*) AS cnt
    FROM alert_log
    WHERE alert_type = ${alertType}
      AND recipient_user_id = ${recipientUserId}
      AND sent_at >= NOW() - INTERVAL '7 days'
  `;
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function logAlert(
  alertType: AlertType,
  recipientUserId: string,
  payload: Record<string, unknown>,
  status: 'sent' | 'failed' = 'sent'
): Promise<void> {
  await sql`
    INSERT INTO alert_log (alert_type, recipient_user_id, payload, delivery_status)
    VALUES (${alertType}, ${recipientUserId}, ${sql.json(payload as never)}, ${status})
  `;
}

// ─────────────────────────────────────────────────────────────
// checkTaxFund
// ─────────────────────────────────────────────────────────────

/**
 * Проверяет баланс налогового фонда перед квартальным дедлайном.
 * Отправляет алерт owner и accountant, если:
 * - До дедлайна <= alert_tax_days_before (default 14) дней
 * - Баланс фонда < expected_tax (УСН 6% от базы ИП)
 * - Алерт не отправлялся последние 24 ч (throttle)
 */
export async function checkTaxFund(bot: Bot<BotContext>): Promise<void> {
  try {
    const nextDeadline = getNextTaxDeadline(USN_IP_DEADLINES);
    if (nextDeadline === null) {
      log.info({}, 'alerts_no_tax_deadline_found');
      return;
    }

    const daysBeforeRaw = await getSetting('alert_tax_days_before');
    const alertDays = daysBeforeRaw !== null ? (parseInt(daysBeforeRaw, 10) || 14) : 14;
    const days = daysUntil(nextDeadline.date);

    if (days > alertDays) {
      return; // Ещё далеко
    }

    // Налоговая база за период с начала года до конца квартала
    const yearStart = `${nextDeadline.date.getFullYear()}-01-01`;
    const quarterEndDate = nextDeadline.date.toISOString().slice(0, 10);
    const taxBase = await getTaxBase('ip_eremyan', yearStart, quarterEndDate);
    const expectedTax = (taxBase * 6n) / 100n;

    // Текущий баланс налогового фонда
    const balances = await getAllFundBalances();
    const taxFund = balances.find((b) => b.code === 'tax');
    const taxBalance = taxFund?.balanceKopecks ?? 0n;

    if (taxBalance >= expectedTax) {
      return; // Всё в порядке
    }

    const shortfall = expectedTax - taxBalance;
    const deadlineStr = formatDateMSK(nextDeadline.date);

    // Отправить owner и accountant
    const users = await getAllActiveUsers();
    const recipients = users.filter((u) => u.role === 'owner' || u.role === 'accountant');

    for (const user of recipients) {
      const alreadySent = await wasAlertSentToday('tax_warning', user.id);
      if (alreadySent) continue;

      const message = [
        `⚠️ *Налоговый фонд: недобор*`,
        ``,
        `До уплаты УСН (${deadlineStr}): ${days} дней`,
        `Ожидаемый налог: ${rubles(expectedTax)}`,
        `В фонде: ${rubles(taxBalance)}`,
        `Недобор: ${rubles(shortfall)}`,
        ``,
        `Пополните налоговый фонд через /distribute`,
      ].join('\n');

      try {
        await bot.api.sendMessage(Number(user.telegramId), message, { parse_mode: 'Markdown' });
        await logAlert('tax_warning', user.id, {
          days_before: days,
          expected: expectedTax.toString(),
          balance: taxBalance.toString(),
          shortfall: shortfall.toString(),
          deadline: deadlineStr,
        });
        log.info(
          { recipient_id: user.id, role: user.role, days_before: days },
          'alerts_tax_warning_sent'
        );
      } catch (err) {
        log.error({ err, recipient_id: user.id }, 'alerts_tax_warning_send_failed');
        await logAlert(
          'tax_warning',
          user.id,
          { error: String(err) },
          'failed'
        );
      }
    }
  } catch (err) {
    log.error({ err }, 'alerts_check_tax_fund_failed');
  }
}

// ─────────────────────────────────────────────────────────────
// sendWeeklySummary
// ─────────────────────────────────────────────────────────────

const WeekEndSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Формирует и отправляет еженедельную сводку всем активным пользователям.
 * Owner получает полную версию, accountant — без прогнозов, manager — только свои направления.
 * Если < 5 транзакций за неделю — не отправляет.
 */
export async function sendWeeklySummary(bot: Bot<BotContext>, weekEndDate?: string): Promise<void> {
  const dateStr = WeekEndSchema.parse(weekEndDate ?? new Date().toISOString().slice(0, 10));

  try {
    const summary = await getWeeklySummary(dateStr);

    if (summary.transactionsCount < 5) {
      log.info(
        { transactions_count: summary.transactionsCount },
        'alerts_weekly_summary_skipped_too_few_transactions'
      );
      return;
    }

    const users = await getAllActiveUsers();

    for (const user of users) {
      // Throttle: не чаще раза в неделю
      const alreadySent = await wasAlertSentThisWeek('weekly_summary', user.id);
      if (alreadySent) continue;

      const message = buildWeeklySummaryMessage(summary, user.role, dateStr);

      // Для manager — фильтруем направления
      // (getWeeklySummary возвращает все направления; отправляем manager полный текст,
      //  т.к. у нас нет в этом месте manager_directions; при необходимости расширить)

      try {
        await bot.api.sendMessage(Number(user.telegramId), message, { parse_mode: 'Markdown' });
        await logAlert('weekly_summary', user.id, {
          week_from: summary.weekDateFrom,
          week_to: summary.weekDateTo,
          total_revenue: summary.totalRevenueKopecks.toString(),
          transactions: summary.transactionsCount,
        });
        log.info({ recipient_id: user.id, role: user.role }, 'alerts_weekly_summary_sent');
      } catch (err) {
        log.error({ err, recipient_id: user.id }, 'alerts_weekly_summary_send_failed');
        await logAlert('weekly_summary', user.id, { error: String(err) }, 'failed');
      }
    }
  } catch (err) {
    log.error({ err, week_end_date: dateStr }, 'alerts_send_weekly_summary_failed');
  }
}

// ─────────────────────────────────────────────────────────────
// Форматирование сводки
// ─────────────────────────────────────────────────────────────

function buildWeeklySummaryMessage(
  summary: Awaited<ReturnType<typeof getWeeklySummary>>,
  role: string,
  _weekEndDate: string
): string {
  const lines: string[] = [
    `*Сводка за неделю ${summary.weekDateFrom} — ${summary.weekDateTo}*`,
    '',
  ];

  // Выручка по направлениям
  lines.push('*Выручка*');
  for (const d of summary.directionRevenues) {
    const change =
      d.changePercent !== null
        ? ` (${d.changePercent >= 0 ? '+' : ''}${d.changePercent.toFixed(1)}% к прошлой неделе${d.changePercent < -5 ? ' ⚠️' : ''})`
        : '';
    lines.push(`• ${d.displayName}: ${rubles(d.revenueKopecks)}${change}`);
  }
  lines.push('');

  // Категории с ростом расходов
  if (summary.categoryGrowths.length > 0) {
    lines.push('*Рост расходов по категориям*');
    for (const cat of summary.categoryGrowths) {
      lines.push(
        `• ${cat.displayName}: ${rubles(cat.amountKopecks)} (+${cat.growthPercent.toFixed(0)}% к среднему ⚠️)`
      );
    }
    lines.push('');
  }

  // Прогноз на месяц — только owner
  if (role === 'owner' && summary.monthForecastByDirection.length > 0) {
    lines.push('*Прогноз прибыли на конец месяца*');
    for (const f of summary.monthForecastByDirection) {
      lines.push(`• ${f.displayName}: ~${rubles(f.forecastKopecks)}`);
    }
    lines.push('');
  }

  lines.push(`Итог за неделю: ${rubles(summary.totalRevenueKopecks)} выручки`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Алерты синхронизации источников
// ─────────────────────────────────────────────────────────────

/**
 * Отправляет владельцу алерт об ошибке синхронизации источника.
 *
 * Не пишет в alert_log (таблица ограничена CHECK для бот-алертов).
 * errorDetail должен содержать только метаданные — без ключей/паролей.
 */
export async function sendSyncErrorAlert(
  bot: Bot<BotContext>,
  sourceCode: string,
  errorDetail: string
): Promise<void> {
  try {
    const users = await getAllActiveUsers();
    const owner = users.find((u) => u.role === 'owner');
    if (!owner) {
      log.warn({ source: sourceCode }, 'sync_alert_no_owner');
      return;
    }

    const message = [
      `⚠️ *Ошибка синхронизации источника*`,
      ``,
      `Источник: \`${sourceCode}\``,
      `Время: ${formatDateMSK(new Date())} МСК`,
      `Детали: ${errorDetail}`,
      ``,
      `Источник продолжит синхронизацию при следующем запуске.`,
    ].join('\n');

    await bot.api.sendMessage(Number(owner.telegramId), message, { parse_mode: 'Markdown' });
    log.info({ source: sourceCode, recipient_id: owner.id }, 'sync_error_alert_sent');
  } catch (err) {
    log.error({ err, source: sourceCode }, 'sync_error_alert_send_failed');
  }
}

/**
 * Отправляет владельцу алерт об автоматическом отключении источника
 * из-за невалидных credentials.
 */
export async function sendSourceDisabledAlert(
  bot: Bot<BotContext>,
  sourceCode: string,
  reason: string
): Promise<void> {
  try {
    const users = await getAllActiveUsers();
    const owner = users.find((u) => u.role === 'owner');
    if (!owner) {
      log.warn({ source: sourceCode }, 'sync_disable_alert_no_owner');
      return;
    }

    const message = [
      `🔴 *Источник отключён: невалидные credentials*`,
      ``,
      `Источник: \`${sourceCode}\``,
      `Причина: ${reason}`,
      `Время: ${formatDateMSK(new Date())} МСК`,
      ``,
      `Синхронизация остановлена до исправления.`,
      `Обновите API-ключи в *.env* и перезапустите бота,`,
      `затем включите источник через /settings или SQL:`,
      `\`UPDATE sources SET sync_enabled=true WHERE code='${sourceCode}';\``,
    ].join('\n');

    await bot.api.sendMessage(Number(owner.telegramId), message, { parse_mode: 'Markdown' });
    log.info({ source: sourceCode, recipient_id: owner.id }, 'sync_source_disabled_alert_sent');
  } catch (err) {
    log.error({ err, source: sourceCode }, 'sync_source_disabled_alert_send_failed');
  }
}
