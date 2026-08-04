/**
 * Авто-уведомление бухгалтера о движениях, которые могут быть ЗП.
 *
 * Правило (зафиксировано 02.08.2026): КАЖДОЕ снятие наличных и перевод на карты
 * людей (Еремян / Азизова / Скрипникова / Лилиана) бот автоматически отправляет
 * бухгалтеру (роль accountant) в личку на подтверждение «кому это ЗП». Бухгалтер
 * отвечает фамилиями и суммами → они разносятся по ведомости ФОТ.
 *
 * Дедуп через alert_log (type='fot_ask:<external_id>') — каждая операция
 * уведомляется РОВНО один раз. Запускается попутно из tochkaSync (2×/день).
 * Serverless-отправка: прямой fetch к Telegram, без grammY.
 *
 * Для разбора ответа: на каждый вопрос сохраняем связку в fot_pending
 * (transaction_id ↔ chat_id+message_id), чтобы reply бухгалтера привязать к
 * конкретному снятию и карте. Определение карты — по описанию Точки (номер
 * карты в тексте): …7848=Лилиана, …7820=Карина, скрипников=Скрипникова.
 */
import { sql } from '../db/client.js';
import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { rubles } from '../utils/money.js';

const log = childLogger({ handler: 'fot-notify' });

/** Люди, чьи карты/переводы бухгалтер подтверждает как ЗП. */
const CARD_PEOPLE_RE = 'еремян|азизов|скрипников|лилиан';
/** Признак снятия/выдачи наличных в назначении. */
const CASH_RE = 'выдача наличных|снятие наличных';

/** Код карты по описанию Точки (номер карты пишется прямо в назначении). */
export function detectCard(descr: string | null, cp: string | null): string | null {
  const s = `${descr ?? ''} ${cp ?? ''}`;
  if (/7848/.test(s)) return 'liliana';
  if (/7820/.test(s)) return 'karina';
  if (/скрипников/i.test(s)) return 'skripnikova';
  if (/азизов|лилиан/i.test(s)) return 'liliana';
  if (/еремян|получатель\s+карин|\+7\s*925\s*779-?32-?27/i.test(s)) return 'karina';
  if (/выдача наличных|снятие наличных/i.test(descr ?? '')) return 'cash';
  return null;
}

/** Человекочитаемое имя карты. */
const CARD_LABEL: Record<string, string> = {
  liliana: 'карта Лилианы …7848',
  karina: 'карта Карины …7820',
  skripnikova: 'карта Скрипниковой',
  cash: 'наличные',
};

async function accountantChatIds(): Promise<bigint[]> {
  const rows = await sql<{ telegram_id: bigint | null }[]>`
    SELECT telegram_id FROM app_users
    WHERE is_active = true AND role = 'accountant' AND telegram_id IS NOT NULL
  `;
  return rows.map((r) => r.telegram_id).filter((x): x is bigint => x !== null);
}

/** Шлёт сообщение, возвращает message_id (или null). */
async function sendTg(chatId: bigint, text: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.toString(), text }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { message_id?: number } };
    return body.result?.message_id ?? null;
  } catch (err) {
    log.error({ err: String(err) }, 'fot_notify_send_error');
    return null;
  }
}

export interface FotNotifyResult {
  candidates: number;
  notified: number;
}

/**
 * Находит новые движения-кандидаты (снятие налички + переводы на карты людей),
 * ещё не отправленные бухгалтеру, и шлёт по каждому запрос на распределение ЗП.
 */
export async function notifyFotDistribution(): Promise<FotNotifyResult> {
  const rows = await sql<
    { id: string; ext: string | null; d: string; amount: bigint; descr: string | null; cp: string | null }[]
  >`
    SELECT t.id, t.external_id AS ext, to_char(t.occurred_at, 'DD.MM.YYYY') AS d,
           t.amount_rub AS amount, t.description AS descr, t.counterparty AS cp
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.flow_type = 'expense'
      AND t.external_id IS NOT NULL
      AND t.occurred_at >= NOW() - INTERVAL '21 days'
      AND (t.description ~* ${CASH_RE} OR t.counterparty ~* ${CARD_PEOPLE_RE})
      AND NOT EXISTS (SELECT 1 FROM alert_log a WHERE a.type = 'fot_ask:' || t.external_id)
    ORDER BY t.occurred_at
  `;
  if (rows.length === 0) return { candidates: 0, notified: 0 };

  const accountants = await accountantChatIds();
  if (accountants.length === 0) {
    log.warn({}, 'fot_notify_no_accountants');
    return { candidates: rows.length, notified: 0 };
  }

  let notified = 0;
  for (const r of rows) {
    if (r.ext === null) continue;
    const card = detectCard(r.descr, r.cp);
    const cardStr = card !== null ? ` (${CARD_LABEL[card] ?? card})` : '';
    const isCash = new RegExp(CASH_RE, 'i').test(r.descr ?? '');
    const what = isCash ? `Снятие наличных${cardStr}` : `Перевод${cardStr}: ${r.cp ?? '—'}`;
    const msg =
      `💵 ${r.d} — ${what} ${rubles(r.amount)}.\n\n` +
      `Кому на ЗП? Ответь на это сообщение фамилиями и суммами ` +
      `(напр.: Токарь 60000, Чеканова 40000).\n` +
      `Если это не ЗП — ответь «не зп».`;

    let anySent = false;
    for (const cid of accountants) {
      const messageId = await sendTg(cid, msg);
      if (messageId !== null) {
        anySent = true;
        // Связка для разбора ответа бухгалтера.
        await sql`
          INSERT INTO fot_pending (transaction_id, chat_id, message_id, amount_kopecks, card_code)
          VALUES (${r.id}, ${cid}, ${messageId}, ${r.amount}, ${card})
        `;
      }
    }
    if (anySent) {
      await sql`
        INSERT INTO alert_log (type, sent_to, message)
        VALUES (${'fot_ask:' + r.ext}, ${accountants[0]!}, ${msg})
      `;
      notified++;
    }
  }
  log.info({ candidates: rows.length, notified }, 'fot_notify_done');
  return { candidates: rows.length, notified };
}
