/**
 * Анализ личных трат Карины по карте «Карина пластик» …7820.
 *
 * Категории (по мерчанту из описания Точки): Озон, Wildberries, Заправка,
 * Кафе/рестораны, Продукты, Детские, Прочее. Периоды: неделя / 2 недели / месяц.
 * Бот шлёт сводку Карине В ЛИЧКУ (chat_id из settings personal_report_chat_id,
 * по умолчанию owner Карина). Данные — из синка Точки (карта …7820 на счёте ИП),
 * ручной доступ к Хрому/Точке не нужен.
 *
 * Serverless-отправка: прямой fetch к Telegram, без grammY.
 */
import { sql } from '../db/client.js';
import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ handler: 'personal-spending' });

/** Карта «Карина пластик». */
const CARD = '7820';
/** Куда слать (личка Карины). Owner Karina Era. */
const DEFAULT_CHAT = '1631024';

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Порядок вывода категорий. */
const CATEGORY_ORDER = ['Продукты', 'Озон', 'Wildberries', 'Кафе/рестораны', 'Заправка', 'Детские', 'Прочее'];

/** Категория личной траты по описанию операции (мерчант/терминал). */
export function categorizePersonal(descr: string | null): string {
  const s = (descr ?? '').toLowerCase();
  if (/ozon|озон/.test(s)) return 'Озон';
  if (/wildber|вайлдбер|wildberries|\bwb\b|валбер/.test(s)) return 'Wildberries';
  if (/детск|detmir|детский\s*мир|дочки|сынки|\bkids\b|toy|игрушк/.test(s)) return 'Детские';
  if (/азс|заправ|gazprom|газпромнефт|lukoil|лукойл|rosneft|роснефт|нефт|tatneft|татнефт|shell|neftemag|трасса|\bбп\b|\bbp\b|circle\s*k|teboil|нефтемагистраль/.test(s)) return 'Заправка';
  if (/пятероч|pyater|магнит|magnit|\bлента\b|\blenta\b|перекр|perekr|вкусвилл|vkusvill|ашан|auchan|дикси|diksi|азбука|metro|метро|\bокей\b|globus|глобус|продукт|мяснов|verol|самокат|samokat|яндекс\s*лавка|yandex\s*lavka|купер|kuper|сбермаркет/.test(s)) return 'Продукты';
  if (/кафе|ресторан|cafe|coffee|кофе|pizza|пицц|dodo|додо|kfc|kfс|mcdonald|burger|бургер|шаурм|starbuck|шоколадниц|теремок|вкусно\s*и\s*точк|kebab|суши|sushi|\bбар\b|\bpub\b|столов|блинн|донер|tanuki|тануки|якитори/.test(s)) return 'Кафе/рестораны';
  return 'Прочее';
}

interface Row { occurred_at: string; amount: bigint; description: string | null }

async function fetchCardRows(days: number): Promise<Row[]> {
  return await sql<Row[]>`
    SELECT occurred_at::text AS occurred_at, amount_rub AS amount, description
    FROM transactions
    WHERE deleted_at IS NULL
      AND flow_type = 'expense'
      AND description ~ ${CARD}
      AND occurred_at >= NOW() - make_interval(days => ${days})
    ORDER BY occurred_at DESC
  `;
}

function fmt(kop: bigint | number): string {
  return `${Math.round(Number(kop) / 100).toLocaleString('ru-RU')} ₽`;
}

/** Границы периода (МСК-дата, dd.mm). */
function periodLabel(days: number): string {
  const now = new Date(Date.now() + 3 * 3600 * 1000);
  const from = new Date(now.getTime() - (days - 1) * 86400 * 1000);
  const d = (x: Date): string => `${x.getUTCDate()} ${MONTHS_GEN[x.getUTCMonth()]}`;
  return `${d(from)} – ${d(now)}`;
}

interface PeriodSummary { total: bigint; byCat: Map<string, bigint>; count: number }

function summarize(rows: Row[], days: number): PeriodSummary {
  const cutoff = Date.now() - days * 86400 * 1000;
  const byCat = new Map<string, bigint>();
  let total = 0n;
  let count = 0;
  for (const r of rows) {
    if (new Date(r.occurred_at).getTime() < cutoff) continue;
    const cat = categorizePersonal(r.description);
    byCat.set(cat, (byCat.get(cat) ?? 0n) + r.amount);
    total += r.amount;
    count++;
  }
  return { total, byCat, count };
}

function renderPeriod(title: string, label: string, s: PeriodSummary): string {
  const lines = [`<b>${title}</b> (${label})`];
  if (s.count === 0) {
    lines.push('  трат нет');
    return lines.join('\n');
  }
  const entries = CATEGORY_ORDER
    .map((c) => [c, s.byCat.get(c) ?? 0n] as const)
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1));
  for (const [c, v] of entries) lines.push(`  • ${c} — ${fmt(v)}`);
  lines.push(`  <b>Итого — ${fmt(s.total)}</b>`);
  return lines.join('\n');
}

export interface PersonalReport {
  text: string;
  week: PeriodSummary;
  twoWeeks: PeriodSummary;
  month: PeriodSummary;
  sampleDescriptions: string[];
}

/** Собирает отчёт по личным тратам (карта …7820) за 3 периода. */
export async function buildPersonalReport(): Promise<PersonalReport> {
  const rows = await fetchCardRows(31);
  const week = summarize(rows, 7);
  const twoWeeks = summarize(rows, 14);
  const month = summarize(rows, 30);

  const text = [
    `💳 <b>Личные траты — карта …7820</b>`,
    ``,
    renderPeriod('За неделю', periodLabel(7), week),
    ``,
    renderPeriod('За 2 недели', periodLabel(14), twoWeeks),
    ``,
    renderPeriod('За месяц', periodLabel(30), month),
  ].join('\n');

  // Для диагностики: примеры «Прочее», чтобы донастроить категории.
  const sampleDescriptions = rows
    .filter((r) => categorizePersonal(r.description) === 'Прочее')
    .slice(0, 15)
    .map((r) => (r.description ?? '').slice(0, 70));

  return { text, week, twoWeeks, month, sampleDescriptions };
}

async function chatId(): Promise<string> {
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM settings WHERE key = 'personal_report_chat_id'
  `;
  return rows[0]?.value ?? DEFAULT_CHAT;
}

async function sendTg(chat: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      log.error({ status: res.status, body: b.slice(0, 200) }, 'personal_send_failed');
    }
    return res.ok;
  } catch (err) {
    log.error({ err: String(err) }, 'personal_send_error');
    return false;
  }
}

export interface PersonalSendResult {
  sent: boolean;
  weekTotal: string;
  monthTotal: string;
  sampleDescriptions: string[];
}

/** Собирает и отправляет сводку личных трат Карине в личку. */
export async function sendPersonalReport(): Promise<PersonalSendResult> {
  const report = await buildPersonalReport();
  const chat = await chatId();
  const sent = await sendTg(chat, report.text);
  log.info({ sent, week: Number(report.week.total), month: Number(report.month.total) }, 'personal_report_done');
  return {
    sent,
    weekTotal: fmt(report.week.total),
    monthTotal: fmt(report.month.total),
    sampleDescriptions: report.sampleDescriptions,
  };
}
