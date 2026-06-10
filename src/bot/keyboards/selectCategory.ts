import { InlineKeyboard } from 'grammy';
import { sql } from '../../db/client.js';
import type { FlowType } from '../../types.js';

interface CategoryRow {
  id: string;
  code: string;
  display_name: string;
  flow_type: string;
}

const PAGE_SIZE = 6;

/**
 * Клавиатура выбора категории с пагинацией.
 *
 * - Загружает категории из БД WHERE flow_type = flowType AND is_active = true.
 * - PAGE_SIZE = 6, по 2 кнопки в ряд.
 * - Если страниц > 1 — кнопки навигации cat:prev:<page> / cat:next:<page>.
 * - callback_data: cat:select:<categoryId>
 */
export async function selectCategoryKeyboard(
  flowType: FlowType,
  page = 0
): Promise<InlineKeyboard> {
  const rows = await sql<CategoryRow[]>`
    SELECT id, code, display_name, flow_type
    FROM categories
    WHERE flow_type = ${flowType}
      AND is_active = true
      AND deleted_at IS NULL
    ORDER BY display_order ASC NULLS LAST, display_name ASC
  `;

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageItems = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const kb = new InlineKeyboard();

  for (let i = 0; i < pageItems.length; i++) {
    const item = pageItems[i];
    if (item === undefined) continue;

    kb.text(item.display_name, `cat:select:${item.id}`);

    // 2 кнопки в ряд — перенос после каждой чётной (индекс 1, 3, 5…)
    if (i % 2 === 1) {
      kb.row();
    }
  }

  // Если последняя строка была неполной (нечётное количество), row() уже не нужен,
  // но навигация всё равно идёт на новой строке
  if (totalPages > 1) {
    kb.row();

    if (safePage > 0) {
      kb.text('← Назад', `cat:prev:${safePage}`);
    }

    kb.text(`${safePage + 1} / ${totalPages}`, 'cat:noop');

    if (safePage < totalPages - 1) {
      kb.text('Вперёд →', `cat:next:${safePage}`);
    }
  }

  return kb;
}
