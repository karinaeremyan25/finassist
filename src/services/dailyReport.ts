/**
 * Ежедневный финансовый отчёт в группу «Фин.отдел ПСИЗ».
 *
 * Формат — как у бухгалтера Светланы (жирные заголовки, HTML parse_mode):
 *   ДОХОД: план на месяц / факт с 1-го / факт сегодня / % выполнения
 *   РАСХОД: то же
 *   ОСТАТКИ: фонды ИП (Точка ИП, Благодарность, Кредиты, Резерв, Земля, Налог),
 *            Итого ИП, ООО Ассургина, ИТОГО
 *
 * Отправляется автоматически 2×/день (10:00 и 21:00 МСК) попутно из tochkaSync
 * (только для крон-запусков). Serverless-отправка: прямой fetch к Telegram.
 *
 * chat_id группы хранится в settings (key='report_chat_id'), план — в
 * monthly_plans, факт — getMonthActuals, остатки — funds.balance.
 */
import { sql } from '../db/client.js';
import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { getMonthlyPlan, getMonthActuals } from '../db/repositories/plans.js';

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
function mskParts(): { y: number; m: number; d: number; ym: string; today: string } {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth() + 1;
  const d = msk.getUTCDate();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { y, m, d, ym: `${y}-${pad(m)}`, today: `${y}-${pad(m)}-${pad(d)}` };
}

async function reportChatId(): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM settings WHERE key = 'report_chat_id'
  `;
  return rows[0]?.value ?? null;
}

async function fundBalances(): Promise<Record<string, bigint>> {
  const rows = await sql<{ code: string; balance: bigint | null }[]>`
    SELECT code, balance FROM funds WHERE deleted_at IS NULL AND code IS NOT NULL
  `;
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.code] = r.balance ?? 0n;
  return out;
}

/** Доход/расход факт за один день [today, today+1). */
async function todayActuals(today: string): Promise<{ income: bigint; expense: bigint }> {
  const inc = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS total FROM transactions
    WHERE deleted_at IS NULL AND flow_type = 'income'
      AND occurred_at >= ${today}::date AND occurred_at < (${today}::date + 1)
  `;
  const exp = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(amount_rub), 0)::bigint AS total FROM transactions
    WHERE deleted_at IS NULL AND flow_type = 'expense'
      AND occurred_at >= ${today}::date AND occurred_at < (${today}::date + 1)
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
  const { m, d, ym, today } = mskParts();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const nextYm = m === 12 ? `${mskParts().y + 1}-01` : `${ym.slice(0, 5)}${pad(m + 1)}`;
  const monthStart = `${ym}-01`;
  const nextMonthStart = `${nextYm}-01`;

  // Строго последовательно (postgres.js max:1, transaction-mode pooler).
  const plan = await getMonthlyPlan(ym);
  const actuals = await getMonthActuals(monthStart, nextMonthStart);
  const tAct = await todayActuals(today);
  const funds = await fundBalances();

  const g = (c: string): bigint => funds[c] ?? 0n;
  const ipCodes = ['rs_ip', 'gratitude', 'credit', 'reserve_ip', 'land', 'tax_ip'];
  const ipTotal = ipCodes.reduce((s, c) => s + g(c), 0n);
  const oooTotal = g('rs_ooo') + g('ooo_acc2');
  const grandTotal = ipTotal + oooTotal;

  const monthNom = MONTHS_NOM[m - 1];
  const dateGen = `${d} ${MONTHS_GEN[m - 1]}`;

  const lines = [
    `📊 <b>ОТЧЁТ за ${dateGen}</b>`,
    ``,
    `<b>ДОХОД</b>`,
    `План на ${monthNom} — ${fmt(plan?.incomeMin ?? 0n)}`,
    `Факт 1–${d} ${MONTHS_GEN[m - 1]} — ${fmt(actuals.incomeActual)}`,
    `Сегодня — ${fmt(tAct.income)}`,
    `Выполнение плана — <b>${pct(actuals.incomeActual, plan?.incomeMin ?? null)}</b>`,
    ``,
    `<b>РАСХОД</b>`,
    `План на ${monthNom} — ${fmt(plan?.expenseMin ?? 0n)}`,
    `Факт 1–${d} ${MONTHS_GEN[m - 1]} — ${fmt(actuals.expenseActual)}`,
    `Сегодня — ${fmt(tAct.expense)}`,
    `Выполнение плана — <b>${pct(actuals.expenseActual, plan?.expenseMin ?? null)}</b>`,
    ``,
    `—`,
    ``,
    `<b>ОСТАТКИ на ${dateGen}</b>`,
    `Точка ИП — ${fmt(g('rs_ip'))}`,
    `Благодарность — ${fmt(g('gratitude'))}`,
    `Кредиты — ${fmt(g('credit'))}`,
    `Резерв — ${fmt(g('reserve_ip'))}`,
    `Земля — ${fmt(g('land'))}`,
    `Налог — ${fmt(g('tax_ip'))}`,
    `<b>Итого ИП — ${fmt(ipTotal)}</b>`,
    ``,
    `ООО Ассургина — ${fmt(oooTotal)}`,
    `<b>ИТОГО — ${fmt(grandTotal)}</b>`,
  ];
  return lines.join('\n');
}

export interface DailyReportResult {
  sent: boolean;
}

/** Собирает и отправляет ежедневный отчёт в группу «Фин.отдел ПСИЗ». */
export async function sendDailyReport(): Promise<DailyReportResult> {
  const chat = await reportChatId();
  if (chat === null) {
    log.warn({}, 'daily_report_no_chat');
    return { sent: false };
  }
  const text = await buildDailyReportText();
  const sent = await sendTg(chat, text);
  log.info({ sent }, 'daily_report_done');
  return { sent };
}
