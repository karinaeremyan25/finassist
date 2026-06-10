import { InlineKeyboard } from 'grammy';
import { sql } from '../../db/client.js';

/**
 * Клавиатура выбора направления.
 * Для manager — только разрешённые направления (фильтруется по списку allowedIds).
 * callback_data: direction:<code>:<contextKey>
 */
export async function selectDirectionKeyboard(
  contextKey: string,
  allowedDirectionIds?: string[]
): Promise<InlineKeyboard> {
  let directions: { id: string; code: string; display_name: string }[];

  if (allowedDirectionIds !== undefined && allowedDirectionIds.length > 0) {
    directions = await sql<{ id: string; code: string; display_name: string }[]>`
      SELECT id, code, display_name
      FROM directions
      WHERE is_active = true AND id IN ${sql(allowedDirectionIds)}
      ORDER BY display_order ASC, code ASC
    `;
  } else {
    directions = await sql<{ id: string; code: string; display_name: string }[]>`
      SELECT id, code, display_name
      FROM directions
      WHERE is_active = true
      ORDER BY display_order ASC, code ASC
    `;
  }

  const kb = new InlineKeyboard();
  for (const dir of directions) {
    kb.text(`📁 ${dir.display_name}`, `direction:${dir.code}:${contextKey}`).row();
  }
  kb.text('📊 Все направления', `direction:all:${contextKey}`);
  return kb;
}
