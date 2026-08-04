/**
 * Обработчик входящих Telegram-апдейтов (webhook).
 *
 * Serverless: без grammY-рантайма, прямой fetch к Bot API. Принимает уже
 * распарсенный объект update. Пока обрабатывает:
 *   • /start  → приветствие + постоянная кнопка «Открыть аналитику» (web_app)
 *   • (далее) ответы бухгалтера на вопрос «кому ЗП» → аллокация в ведомость
 *
 * Безопасность приёма — на уровне роута (secret_token от Telegram).
 */
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'tg-update' });

const APP_URL = config.WEBAPP_URL ?? 'https://finassist-virid.vercel.app/';

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

  // /start (в личке) → приветствие с кнопкой
  if (/^\/start(@\w+)?\b/.test(text)) {
    await sendWelcome(chatId);
    log.info({ from: fromId }, 'start_handled');
    return;
  }

  // Остальные сообщения — обработка ответов бухгалтера появится на след. шаге.
  log.info({ from: fromId, has_reply: msg.reply_to_message !== undefined }, 'message_received');
}
