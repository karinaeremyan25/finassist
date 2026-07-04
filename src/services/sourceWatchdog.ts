/**
 * Сторож молчания источников.
 *
 * Детектирует ситуацию «источник дохода тихо перестал слать данные» —
 * например, когда вебхук Продамуса отваливается и месяц никто не замечает,
 * пока при сверке не всплывает недостача.
 *
 * Логика: для каждого включённого источника, у которого КОГДА-ЛИБО были
 * поступления (иначе это «никогда не работал», а не «замолчал»), считаем,
 * сколько дней прошло с последнего поступления. Если больше порога —
 * шлём алерт владельцу и бухгалтерам в Telegram.
 *
 * Throttle: не чаще раза в REALERT_COOLDOWN_DAYS дней на источник
 * (через alert_log, type='source_silent:<code>').
 *
 * Запускается кроном раз в сутки (см. /api/cron/source-watchdog + vercel.json).
 * Работает в serverless-контексте: отправка через прямой fetch к Telegram API,
 * без инстанса grammY Bot.
 */

import { sql } from '../db/client.js';
import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { formatDateMSK } from '../utils/dates.js';

const log = childLogger({ handler: 'source-watchdog' });

/**
 * Пороги «молчания» по источникам (дней без новых поступлений).
 * Продамус — высокочастотные продажи, реагируем быстро.
 * Точка — прямые зачисления ООО спорадические, порог выше (меньше ложных).
 */
const SILENCE_THRESHOLD_DAYS: Record<string, number> = {
  prodamus: 3,
  lava: 5,
  tochka: 7,
  robokassa: 5,
};
const DEFAULT_THRESHOLD_DAYS = 5;

/** Не повторять алерт по одному источнику чаще, чем раз в N дней. */
const REALERT_COOLDOWN_DAYS = 3;

/** Роли-получатели: владелец + бухгалтеры. */
const RECIPIENT_ROLES = ['owner', 'accountant'] as const;

interface SilentSource {
  code: string;
  displayName: string;
  lastOccurredAt: Date;
  daysSilent: number;
  threshold: number;
}

export interface WatchdogResult {
  checked: number;
  silent: string[];
  alerted: string[];
  skippedThrottled: string[];
}

// ─────────────────────────────────────────────────────────────
// Поиск молчащих источников
// ─────────────────────────────────────────────────────────────

async function findSilentSources(): Promise<SilentSource[]> {
  const rows = await sql<
    { code: string; display_name: string | null; last_occ: Date | null; n: string }[]
  >`
    SELECT s.code,
           s.display_name,
           MAX(t.occurred_at) AS last_occ,
           COUNT(t.id) AS n
    FROM sources s
    LEFT JOIN transactions t
      ON t.source_id = s.id
     AND t.deleted_at IS NULL
     AND t.flow_type = 'income'
    WHERE s.sync_enabled = true
      AND s.deleted_at IS NULL
    GROUP BY s.code, s.display_name
  `;

  const now = Date.now();
  const silent: SilentSource[] = [];

  for (const r of rows) {
    // «Никогда не было поступлений» — не сторожим (это проблема настройки, не молчания).
    if (r.last_occ === null || Number(r.n) === 0) continue;

    const threshold = SILENCE_THRESHOLD_DAYS[r.code] ?? DEFAULT_THRESHOLD_DAYS;
    const daysSilent = Math.floor((now - r.last_occ.getTime()) / 86_400_000);

    if (daysSilent > threshold) {
      silent.push({
        code: r.code,
        displayName: r.display_name ?? r.code,
        lastOccurredAt: r.last_occ,
        daysSilent,
        threshold,
      });
    }
  }

  return silent;
}

// ─────────────────────────────────────────────────────────────
// Throttle через alert_log
// ─────────────────────────────────────────────────────────────

async function wasAlertedRecently(code: string): Promise<boolean> {
  const type = `source_silent:${code}`;
  const rows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*) AS cnt
    FROM alert_log
    WHERE type = ${type}
      AND created_at >= NOW() - (${REALERT_COOLDOWN_DAYS} || ' days')::interval
  `;
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function logAlert(code: string, telegramId: bigint, message: string): Promise<void> {
  await sql`
    INSERT INTO alert_log (type, sent_to, message)
    VALUES (${`source_silent:${code}`}, ${telegramId}, ${message})
  `;
}

// ─────────────────────────────────────────────────────────────
// Отправка в Telegram (serverless: прямой fetch)
// ─────────────────────────────────────────────────────────────

async function sendTelegramMessage(chatId: bigint, text: string): Promise<boolean> {
  const token = config.BOT_TOKEN;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId.toString(),
        text,
        parse_mode: 'Markdown',
      }),
    });
    return res.ok;
  } catch (err) {
    log.error({ err: String(err) }, 'watchdog_telegram_send_error');
    return false;
  }
}

function buildMessage(s: SilentSource): string {
  return [
    `🔕 *Источник молчит: ${s.displayName}*`,
    ``,
    `Последнее поступление: ${formatDateMSK(s.lastOccurredAt)}`,
    `Тишина: *${s.daysSilent} дн.* (порог ${s.threshold})`,
    ``,
    `Возможно, вебхук/синхронизация отвалились — либо продаж действительно нет.`,
    `Проверь личный кабинет источника и, если это Продамус/Lava,`,
    `что вебхук включён. Тестовый платёж сразу покажет, доходит ли он.`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// Публичная точка входа
// ─────────────────────────────────────────────────────────────

export async function checkSilentSources(): Promise<WatchdogResult> {
  const result: WatchdogResult = { checked: 0, silent: [], alerted: [], skippedThrottled: [] };

  const silent = await findSilentSources();
  result.checked = silent.length;
  result.silent = silent.map((s) => s.code);

  if (silent.length === 0) {
    log.info({}, 'watchdog_all_sources_alive');
    return result;
  }

  // Получатели: владелец + бухгалтеры.
  const recipients = await sql<{ telegram_id: bigint }[]>`
    SELECT telegram_id
    FROM app_users
    WHERE is_active = true
      AND role = ANY(${RECIPIENT_ROLES as unknown as string[]})
  `;

  for (const s of silent) {
    if (await wasAlertedRecently(s.code)) {
      result.skippedThrottled.push(s.code);
      log.info({ source: s.code, days_silent: s.daysSilent }, 'watchdog_throttled');
      continue;
    }

    const message = buildMessage(s);
    let anySent = false;

    for (const rcpt of recipients) {
      const sent = await sendTelegramMessage(rcpt.telegram_id, message);
      if (sent) {
        anySent = true;
        await logAlert(s.code, rcpt.telegram_id, message);
      }
    }

    if (anySent) {
      result.alerted.push(s.code);
      log.info(
        { source: s.code, days_silent: s.daysSilent, recipients: recipients.length },
        'watchdog_alert_sent'
      );
    }
  }

  return result;
}
