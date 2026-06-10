import { InlineKeyboard } from 'grammy';

/**
 * Клавиатура подтверждения транзакции.
 * callback_data: tx:confirm:<tempId> | tx:edit:<tempId> | tx:cancel:<tempId>
 */
export function confirmTransactionKeyboard(tempId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Записать', `tx:confirm:${tempId}`)
    .text('✏️ Изменить', `tx:edit:${tempId}`)
    .text('❌ Отмена', `tx:cancel:${tempId}`);
}

/**
 * Клавиатура выбора поля для редактирования.
 */
export function editFieldKeyboard(tempId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('💰 Сумма', `tx:editfield:amount:${tempId}`)
    .text('🏢 Юрлицо', `tx:editfield:entity:${tempId}`)
    .row()
    .text('📁 Направление', `tx:editfield:direction:${tempId}`)
    .text('📦 Категория', `tx:editfield:category:${tempId}`)
    .row()
    .text('💳 Источник', `tx:editfield:source:${tempId}`)
    .text('📝 Описание', `tx:editfield:description:${tempId}`)
    .row()
    .text('✅ Готово', `tx:confirm:${tempId}`);
}
