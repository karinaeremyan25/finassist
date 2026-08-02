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

async function accountantChatIds(): Promise<bigint[]> {
  const rows = await sql<{ telegram_id: bigint | null }[]>`
    SELECT telegram_id FROM app_users
    WHERE is_active = true AND role = 'accountant' AND telegram_id IS NOT NULL
  `;
  return rows.map((r) => r.telegram_id).filter((x): x is bigint => x !== null);
}

async function sendTg(chatId: bigint, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.toString(), text }),
    });
    return res.ok;
  } catch (err) {
    log.error({ err: String(err) }, 'fot_notify_send_error');
    return false;
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
    const isCash = new RegExp(CASH_RE, 'i').test(r.descr ?? '');
    const what = isCash ? 'Снятие наличных' : `Перевод: ${r.cp ?? '—'}`;
    const msg =
      `💵 ${r.d} — ${what} ${rubles(r.amount)}.\n\n` +
      `Кому на ЗП? Ответь фамилиями и суммами (напр.: Токарь 60000, Чеканова 40000).\n` +
      `Если это не ЗП — напиши «не зп».`;
    let anySent = false;
    for (const cid of accountants) {
      if (await sendTg(cid, msg)) anySent = true;
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
