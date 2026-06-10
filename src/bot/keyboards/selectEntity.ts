import { InlineKeyboard } from 'grammy';
import { sql } from '../../db/client.js';

/**
 * Клавиатура выбора юрлица (entity).
 * Данные загружаются из БД динамически.
 * callback_data: entity:<code>:<contextKey>
 */
export async function selectEntityKeyboard(contextKey: string): Promise<InlineKeyboard> {
  const entities = await sql<{ code: string; display_name: string }[]>`
    SELECT code, display_name FROM entities ORDER BY code
  `;

  const kb = new InlineKeyboard();
  for (const entity of entities) {
    kb.text(entity.display_name, `entity:${entity.code}:${contextKey}`).row();
  }
  return kb;
}

/** Статичная версия для случаев, когда нет подключения к БД. */
export function selectEntityKeyboardStatic(contextKey: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('ИП Карина Еремян', `entity:ip_eremyan:${contextKey}`)
    .row()
    .text('ООО Ассургина', `entity:ooo_assurgina:${contextKey}`)
    .row()
    .text('Личные средства', `entity:personal:${contextKey}`);
}
