import { InlineKeyboard } from 'grammy';

/**
 * Главная клавиатура раздела «Фонды».
 *
 * [💰 Распределить поступление] [📊 История движений]
 * [⚙️ Настройки фондов]
 *
 * callback_data: fund:distribute | fund:history | fund:settings
 */
export function fundMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💰 Распределить поступление', 'fund:distribute')
    .text('📊 История движений', 'fund:history')
    .row()
    .text('⚙️ Настройки фондов', 'fund:settings');
}

/**
 * Клавиатура подтверждения распределения по конкретной транзакции.
 *
 * [✅ Распределить] [✏️ Изменить %] [⏭ Пропустить]
 *
 * callback_data:
 *   dist:execute:<txId>
 *   dist:custom:<txId>
 *   dist:skip:<txId>
 */
export function distributeConfirmKeyboard(txId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Распределить', `dist:execute:${txId}`)
    .text('✏️ Изменить %', `dist:custom:${txId}`)
    .text('⏭ Пропустить', `dist:skip:${txId}`);
}
