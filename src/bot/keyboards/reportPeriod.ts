import { InlineKeyboard } from 'grammy';

interface DirectionOption {
  id: string;
  displayName: string;
}

/**
 * Клавиатура выбора направления для отчёта.
 *
 * Рендерит по одной кнопке на строку для каждого направления,
 * плюс кнопку «Все направления» в конце.
 * callback_data: report:direction:<directionId> | report:direction:all
 */
export function reportDirectionKeyboard(directions: DirectionOption[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const direction of directions) {
    kb.text(direction.displayName, `report:direction:${direction.id}`).row();
  }

  kb.text('📊 Все направления', 'report:direction:all');

  return kb;
}

/**
 * Клавиатура выбора периода для отчёта.
 *
 * [Этот месяц]    [Прошлый месяц]
 * [Этот квартал]  [С начала года]
 * [📆 Свой период]
 *
 * callback_data: report:period:this_month | last_month | this_quarter | ytd | custom
 */
export function reportPeriodKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Этот месяц', 'report:period:this_month')
    .text('Прошлый месяц', 'report:period:last_month')
    .row()
    .text('Этот квартал', 'report:period:this_quarter')
    .text('С начала года', 'report:period:ytd')
    .row()
    .text('📆 Свой период', 'report:period:custom');
}
