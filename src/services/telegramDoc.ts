/**
 * Отправка файла ботом в чат пользователя (Telegram sendDocument).
 * Общий хелпер для выгрузок (Excel) и платёжек (PDF).
 */

import { config } from '../config.js';

export async function sendDocumentToChat(
  chatId: bigint,
  filename: string,
  buf: Buffer,
  mime: string,
  caption: string
): Promise<boolean> {
  const token = config.BOT_TOKEN;
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('chat_id', chatId.toString());
  form.append('caption', caption.slice(0, 1024));
  form.append('document', blob, filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  return res.ok;
}
