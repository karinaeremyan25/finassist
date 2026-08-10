/**
 * Ежедневный финансовый отчёт в группу «Фин.отдел ПСИЗ».
 *
 * Формат — как у бухгалтера Светланы (жирные заголовки, HTML parse_mode):
 *   ДОХОД:  план на месяц / факт с 1-го / план сегодня / факт сегодня / % выполнения
 *   РАСХОД: то же
 *   ОСТАТКИ: фонды ИП с % (Точка ИП, Благодарность 65%, Кредиты 10%, Резерв 7%,
 *            Земля 5%, Налог 8%), Итого ИП, ООО Ассургина, ИТОГО
 *
 * Отправляется 2×/день в 11:00 и 20:30 МСК. Точность времени — внешним кроном
 * (cron-job.org → /api/cron/daily-report), плюс подстраховка попутно из tochkaSync.
 * Дедуп по слоту (утро/вечер) через alert_log — отчёт уходит РОВНО один раз за слот.
 *
 * Считает доход/расход через pnlActuals (ТА ЖЕ логика, что P&L «сводная»:
 * доход без займов, расход без личного). План месяца — monthly_plans, план дня —
 * daily_plan (если задан) иначе месяц/кол-во дней. Остатки — funds.balance.
 */
import { sql } from '../db/client.js';
import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { getMonthlyPlan } from '../db/repositories/plans.js';

const log = childLogger({ handler: 'daily-report' });

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_NOM = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/** "1 900 000 ₽" — полное число, без копеек, неразрывный пробел-разделитель. */
function fmt(kop: bigint | number): string {
  const rub = Math.round(Number(kop) / 100);
  return `${rub.toLocaleString('ru-RU')} ₽`;
}

/** "111,47%" — процент выполнения плана; "—" если плана нет. */
function pct(actual: bigint, plan: bigint | null): string {
  if (plan === null || plan === 0n) return '—';
  const p = (Number(actual) / Number(plan)) * 100;
  return `${p.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/** Части текущей даты в МСК (сервер в UTC; +3ч). */
function mskParts(): { y: number; m: number; d: number; hour: number; ym: string; today: string } {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth() + 1;
  const d = msk.getUTCDate();
  const hour = msk.getUTCHours();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { y, m, d, hour, ym: `${y}-${pad(m)}`, today: `${y}-${pad(m)}-${pad(d)}` };
}

async function reportChatId(): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM settings WHERE key = 'report_chat_id'
  `;
  return rows[0]?.value ?? null;
}

interface FundInfo {
  balance: bigint;
  percent: number | null;
}

async function fundBalances(): Promise<Record<string, FundInfo>> {
  const rows = await sql<{ code: string; balance: bigint | null; distribution_percent: string | null }[]>`
    SELECT code, balance, distribution_percent FROM funds WHERE deleted_at IS NULL AND code IS NOT NULL
  `;
  const out: Record<string, FundInfo> = {};
  for (const r of rows) {
    const pctNum = r.distribution_percent === null ? null : Math.round(Number(r.distribution_percent));
    out[r.code] = { balance: r.balance ?? 0n, percent: pctNum };
  }
  return out;
}

/**
 * Доход/расход факт за период [from, to) — ТОЧНО по логике P&L «сводная»:
 *   доход  = flow_type='income'  без займов (pnl_category ≠ 'loan')
 *   расход = flow_type='expense' без личного (is_personal ≠ true)
 * Границы — ISO-строки дат ('2026-08-01'). Так отчёт бота = P&L = бухгалтер.
 */
async function pnlActuals(
  from: string,
  to: string,
  entityCode?: 'IP' | 'OOO'
): Promise<{ income: bigint; expense: bigint }> {
  const ent =
    entityCode !== undefined
      ? sql`AND entity_id = (SELECT id FROM entities WHERE code = ${entityCode})`
      : sql``;
  const inc = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS total FROM transactions
    WHERE deleted_at IS NULL AND flow_type = 'income'
      AND pnl_category IS DISTINCT FROM 'loan'
      AND occurred_at >= ${from}::date AND occurred_at < ${to}::date
      ${ent}
  `;
  const exp = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS total FROM transactions
    WHERE deleted_at IS NULL AND flow_type = 'expense'
      AND (is_personal = false OR is_personal IS NULL)
      AND occurred_at >= ${from}::date AND occurred_at < ${to}::date
      ${ent}
  `;
  return { income: inc[0]?.total ?? 0n, expense: exp[0]?.total ?? 0n };
}

async function sendTg(chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body: body.slice(0, 300) }, 'daily_report_send_failed');
    }
    return res.ok;
  } catch (err) {
    log.error({ err: String(err) }, 'daily_report_send_error');
    return false;
  }
}

/** Собирает текст отчёта (HTML). Экспортируется для теста/предпросмотра. */
export async function buildDailyReportText(): Promise<string> {
  const { y, m, d, ym, today } = mskParts();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const nextYm = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  const monthStart = `${ym}-01`;
  const nextMonthStart = `${nextYm}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  // Следующий день (для границы «сегодня») — парсинг ISO-строки, не Date.now().
  const nextDay = new Date(`${today}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const tomorrow = nextDay.toISOString().slice(0, 10);

  // Строго последовательно (postgres.js max:1, transaction-mode pooler).
  // План по юрлицам (расход разбиваем ИП / Ассургина; доход — общий).
  const ipPlan = await getMonthlyPlan(ym, 'IP');
  const oooPlan = await getMonthlyPlan(ym, 'OOO');
  const planIncome = (ipPlan?.incomeMin ?? 0n) + (oooPlan?.incomeMin ?? 0n);
  const planExpIp = ipPlan?.expenseMin ?? 0n;
  const planExpOoo = oooPlan?.expenseMin ?? 0n;
  const planExpTotal = planExpIp + planExpOoo;

  // Факт: доход общий, расход общий и по юрлицам; месяц и сегодня.
  const actAll = await pnlActuals(monthStart, nextMonthStart);
  const actIp = await pnlActuals(monthStart, nextMonthStart, 'IP');
  const actOoo = await pnlActuals(monthStart, nextMonthStart, 'OOO');
  const tAll = await pnlActuals(today, tomorrow);
  const tIp = await pnlActuals(today, tomorrow, 'IP');
  const tOoo = await pnlActuals(today, tomorrow, 'OOO');
  const funds = await fundBalances();

  // Дневной план — месяц ÷ число дней (равномерно).
  const days = BigInt(daysInMonth);
  const dPlanIncome = planIncome / days;
  const dPlanExpIp = planExpIp / days;
  const dPlanExpOoo = planExpOoo / days;

  const bal = (c: string): bigint => funds[c]?.balance ?? 0n;
  const ipCodes = ['rs_ip', 'gratitude', 'credit', 'reserve_ip', 'land', 'tax_ip'];
  const ipTotal = ipCodes.reduce((s, c) => s + bal(c), 0n);
  const oooTotal = bal('rs_ooo') + bal('ooo_acc2');
  const grandTotal = ipTotal + oooTotal;

  const monthNom = MONTHS_NOM[m - 1];
  const monthGen = MONTHS_GEN[m - 1];
  const dateGen = `${d} ${monthGen}`;

  // Строка фонда с процентом: «Благодарность 65% — 580 404 ₽».
  const fundLine = (label: string, code: string): string => {
    const p = funds[code]?.percent;
    const pctStr = p !== null && p !== undefined && p > 0 ? ` ${p}%` : '';
    return `${label}${pctStr} — ${fmt(bal(code))}`;
  };

  const lines = [
    `📊 <b>ОТЧЁТ за ${dateGen}</b>`,
    ``,
    `<b>ДОХОД</b>`,
    `План на ${monthNom} — ${fmt(planIncome)}`,
    `Факт 1–${d} ${monthGen} — ${fmt(actAll.income)}`,
    `План/день (в среднем) — ${fmt(dPlanIncome)}`,
    `Факт сегодня — ${fmt(tAll.income)}`,
    `Выполнение плана — <b>${pct(actAll.income, planIncome === 0n ? null : planIncome)}</b>`,
    ``,
    `<b>РАСХОД</b>`,
    `<b>ИП</b>`,
    `План на ${monthNom} — ${fmt(planExpIp)}`,
    `Факт 1–${d} ${monthGen} — ${fmt(actIp.expense)}`,
    `План/день (в среднем) — ${fmt(dPlanExpIp)}`,
    `Факт сегодня — ${fmt(tIp.expense)}`,
    `Выполнение плана — <b>${pct(actIp.expense, planExpIp === 0n ? null : planExpIp)}</b>`,
    ``,
    `<b>Ассургина</b>`,
    `План на ${monthNom} — ${fmt(planExpOoo)}`,
    `Факт 1–${d} ${monthGen} — ${fmt(actOoo.expense)}`,
    `План/день (в среднем) — ${fmt(dPlanExpOoo)}`,
    `Факт сегодня — ${fmt(tOoo.expense)}`,
    `Выполнение плана — <b>${pct(actOoo.expense, planExpOoo === 0n ? null : planExpOoo)}</b>`,
    ``,
    `<b>Всего (ИП+ООО)</b>`,
    `План на ${monthNom} — ${fmt(planExpTotal)}`,
    `Факт 1–${d} ${monthGen} — ${fmt(actAll.expense)}`,
    `План/день (в среднем) — ${fmt(dPlanExpIp + dPlanExpOoo)}`,
    `Факт сегодня — ${fmt(tAll.expense)}`,
    `Выполнение плана — <b>${pct(actAll.expense, planExpTotal === 0n ? null : planExpTotal)}</b>`,
    ``,
    `—`,
    ``,
    `<b>ОСТАТКИ на ${dateGen}</b>`,
    fundLine('Точка ИП', 'rs_ip'),
    fundLine('Благодарность', 'gratitude'),
    fundLine('Кредиты', 'credit'),
    fundLine('Резерв', 'reserve_ip'),
    fundLine('Земля', 'land'),
    fundLine('Налог', 'tax_ip'),
    `<b>Итого ИП — ${fmt(ipTotal)}</b>`,
    ``,
    `ООО Ассургина — ${fmt(oooTotal)}`,
    `<b>ИТОГО — ${fmt(grandTotal)}</b>`,
  ];
  return lines.join('\n');
}

export interface DailyReportResult {
  sent: boolean;
  skipped?: boolean;
}

/**
 * Собирает и отправляет ежедневный отчёт в группу «Фин.отдел ПСИЗ».
 * Дедуп по слоту (утро < 14:00 МСК / вечер) через alert_log — РОВНО один раз
 * за слот в сутки, даже если триггернули из нескольких кронов. force=true —
 * для ручного теста (шлёт всегда, без записи дедупа).
 */
export async function sendDailyReport(force = false): Promise<DailyReportResult> {
  const chat = await reportChatId();
  if (chat === null) {
    log.warn({}, 'daily_report_no_chat');
    return { sent: false };
  }

  const { today, hour } = mskParts();
  const slot = hour < 14 ? 'morning' : 'evening';
  const slotKey = `daily_report:${today}:${slot}`;

  if (!force) {
    const existing = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM alert_log WHERE type = ${slotKey} LIMIT 1
    `;
    if (existing.length > 0) {
      log.info({ slotKey }, 'daily_report_already_sent');
      return { sent: false, skipped: true };
    }
  }

  const text = await buildDailyReportText();
  const sent = await sendTg(chat, text);

  if (sent && !force) {
    await sql`
      INSERT INTO alert_log (type, sent_to, message)
      VALUES (${slotKey}, ${BigInt(chat)}, ${'daily report sent'})
    `;
  }
  log.info({ sent, slot }, 'daily_report_done');
  return { sent };
}
