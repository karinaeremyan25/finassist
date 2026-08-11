/**
 * Обработчик входящих Telegram-апдейтов (webhook).
 *
 * Serverless: без grammY-рантайма, прямой fetch к Bot API. Принимает уже
 * распарсенный объект update. Обрабатывает:
 *   • /start  → приветствие + постоянная кнопка «Открыть аналитику» (web_app)
 *   • ответ бухгалтера на вопрос «кому ЗП» → разбор «Фамилия сумма» → аллокация
 *     в ведомость ФОТ (payroll_allocation) + списание с карты.
 *
 * Безопасность приёма — на уровне роута (secret_token от Telegram).
 */
import { config } from '../../config.js';
import { sql } from '../../db/client.js';
import { rubles } from '../../utils/money.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'tg-update' });

const APP_URL = config.WEBAPP_URL ?? 'https://finassist-virid.vercel.app/';

const CARD_LABEL: Record<string, string> = {
  liliana: 'карта Лилианы',
  karina: 'карта Карины',
  skripnikova: 'карта Скрипниковой',
  cash: 'наличные',
};

interface TgChat { id: number; type?: string }
interface TgUser { id: number; username?: string; first_name?: string }
interface TgMessage {
  message_id?: number;
  chat?: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
}
export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

async function tg(method: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn({ method, status: res.status, body: body.slice(0, 200) }, 'tg_call_failed');
    }
  } catch (err) {
    log.error({ method, err: String(err) }, 'tg_call_error');
  }
}

async function sendWelcome(chatId: number): Promise<void> {
  await tg('sendMessage', {
    chat_id: chatId,
    text:
      '👋 Это <b>FinAssist</b> — финансовая аналитика.\n\n' +
      'Нажми кнопку ниже, чтобы открыть приложение (доход/расход, P&L, фонды).\n' +
      '<i>На Маке лучше открывать в Telegram Desktop.</i>',
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [[{ text: '📊 Открыть аналитику', web_app: { url: APP_URL } }]],
      resize_keyboard: true,
      is_persistent: true,
    },
  });
}

async function isKnownUser(tgId: number): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM app_users
    WHERE telegram_id = ${tgId} AND is_active = true AND deleted_at IS NULL LIMIT 1
  `;
  return rows.length > 0;
}

/** Фиксирует заявку неизвестного пользователя на доступ (для выдачи админом). */
async function captureAccessRequest(
  tgId: number,
  username: string | null,
  name: string | null
): Promise<void> {
  const type = `access_request:${tgId}`;
  const exists = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM alert_log WHERE type = ${type} LIMIT 1
  `;
  if (exists.length === 0) {
    const label = `${username !== null ? '@' + username + ' ' : ''}${name ?? ''}`.trim();
    await sql`
      INSERT INTO alert_log (type, sent_to, message) VALUES (${type}, ${tgId}, ${label})
    `;
  }
}

async function isAccountant(tgId: number): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM app_users
    WHERE telegram_id = ${tgId} AND is_active = true AND role = 'accountant' LIMIT 1
  `;
  return rows.length > 0;
}

interface Pending {
  id: string;
  transaction_id: string | null;
  amount_kopecks: bigint;
  card_code: string | null;
}

/** Находит вопрос, к которому относится ответ: по reply, иначе последний открытый. */
async function findPending(chatId: number, replyMsgId: number | undefined): Promise<Pending | null> {
  if (replyMsgId !== undefined) {
    const byReply = await sql<Pending[]>`
      SELECT id, transaction_id, amount_kopecks, card_code FROM fot_pending
      WHERE chat_id = ${chatId} AND message_id = ${replyMsgId} AND resolved_at IS NULL
      LIMIT 1
    `;
    if (byReply[0] !== undefined) return byReply[0];
  }
  const latest = await sql<Pending[]>`
    SELECT id, transaction_id, amount_kopecks, card_code FROM fot_pending
    WHERE chat_id = ${chatId} AND resolved_at IS NULL
    ORDER BY asked_at DESC LIMIT 1
  `;
  return latest[0] ?? null;
}

/** Разбирает «Токарь 60000, Чеканова 40 000» → [{name, kopecks}]. */
export function parseAllocations(text: string): { name: string; kopecks: bigint }[] {
  const out: { name: string; kopecks: bigint }[] = [];
  for (const part of text.split(/[,;\n]+/)) {
    const m = part.match(/([А-Яа-яЁё][А-Яа-яЁё.\- ]*?)\s*[—:\-]?\s*(\d[\d\s]*)\s*(?:р|руб|₽)?\.?\s*$/);
    if (m === null) continue;
    const name = (m[1] ?? '').trim();
    const digits = (m[2] ?? '').replace(/\s/g, '');
    if (name.length === 0 || digits.length === 0) continue;
    const rub = parseInt(digits, 10);
    if (!Number.isFinite(rub) || rub <= 0) continue;
    out.push({ name, kopecks: BigInt(rub) * 100n });
  }
  return out;
}

async function handleAccountantReply(chatId: number, fromId: number, msg: TgMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  const pending = await findPending(chatId, msg.reply_to_message?.message_id);
  if (pending === null) {
    // Нет открытого вопроса — молчим (обычное сообщение), чтобы не спамить.
    return;
  }

  // «не зп» — закрываем вопрос без аллокаций.
  if (/не\s*зп|не\s*зарплат|это\s+не\s+зп/i.test(text)) {
    await sql`UPDATE fot_pending SET resolved_at = NOW() WHERE id = ${pending.id}`;
    await tg('sendMessage', { chat_id: chatId, text: '✅ Понял, это не ЗП — не заношу в ведомость.' });
    return;
  }

  const allocs = parseAllocations(text);
  if (allocs.length === 0) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Не разобрал. Напиши в формате «Фамилия сумма», через запятую (напр.: Токарь 60000, Чеканова 40000). Или «не зп».',
    });
    return;
  }

  // Контекст операции: месяц и юрлицо.
  let ym = '';
  let entity: string | null = null;
  if (pending.transaction_id !== null) {
    const ctx = await sql<{ ym: string; entity: string | null }[]>`
      SELECT to_char(t.occurred_at, 'YYYY-MM') AS ym, e.code AS entity
      FROM transactions t LEFT JOIN entities e ON e.id = t.entity_id
      WHERE t.id = ${pending.transaction_id}
    `;
    ym = ctx[0]?.ym ?? '';
    entity = ctx[0]?.entity ?? null;
  }

  let sum = 0n;
  for (const a of allocs) {
    await sql`
      INSERT INTO payroll_allocation
        (employee_name, amount_kopecks, card_code, source_transaction_id, year_month, entity_code, raw_reply, created_by)
      VALUES (${a.name}, ${a.kopecks}, ${pending.card_code}, ${pending.transaction_id}, ${ym}, ${entity}, ${text}, ${fromId})
    `;
    sum += a.kopecks;
  }
  await sql`UPDATE fot_pending SET resolved_at = NOW() WHERE id = ${pending.id}`;

  const cardStr = pending.card_code !== null ? (CARD_LABEL[pending.card_code] ?? pending.card_code) : '—';
  const leftover = pending.amount_kopecks - sum;
  const list = allocs.map((a) => `• ${a.name} — ${rubles(a.kopecks)}`).join('\n');
  let reply = `✅ Записал в ведомость (${cardStr}${ym ? ', ' + ym : ''}):\n${list}\nИтого разнесено: ${rubles(sum)}.`;
  if (leftover > 0n) reply += `\n⚠️ Нераспределённый остаток снятия: ${rubles(leftover)}.`;
  else if (leftover < 0n) reply += `\n⚠️ Разнесено больше суммы снятия на ${rubles(-leftover)} — проверь.`;
  await tg('sendMessage', { chat_id: chatId, text: reply });
  log.info({ from: fromId, allocs: allocs.length, ym }, 'fot_reply_parsed');
}

/**
 * Точка входа: обрабатывает один update. Никогда не бросает — все ошибки
 * логируются, чтобы webhook всегда отвечал 200 (иначе Telegram будет ретраить).
 */
export async function handleTelegramUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (msg === undefined) return;

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  const text = (msg.text ?? '').trim();
  if (chatId === undefined || fromId === undefined) return;

  // /start (в личке): известному — приветствие с кнопкой; неизвестному —
  // показываем его ID и фиксируем заявку на доступ (чтобы админ выдал).
  if (/^\/start(@\w+)?\b/.test(text)) {
    const known = await isKnownUser(fromId);
    if (known) {
      await sendWelcome(chatId);
    } else {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          '👋 Это <b>FinAssist</b>.\n\n' +
          `Твой Telegram ID: <code>${fromId}</code>\n` +
          'Передай его администратору — он выдаст доступ.',
        parse_mode: 'HTML',
      });
      await captureAccessRequest(fromId, msg.from?.username ?? null, msg.from?.first_name ?? null);
    }
    log.info({ from: fromId, known }, 'start_handled');
    return;
  }

  // Ответ бухгалтера на вопрос «кому ЗП» (только личка бухгалтера, только текст).
  if (msg.chat?.type === 'private' && text.length > 0 && (await isAccountant(fromId))) {
    await handleAccountantReply(chatId, fromId, msg);
    return;
  }

  log.info({ from: fromId }, 'message_ignored');
}
