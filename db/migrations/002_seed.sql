-- 002_seed.sql
-- Стартовые справочники: юрлица, направления, категории, источники,
-- фонды, настройки, правила маппинга Продамуса.
--
-- DOWN-логика (откат): DELETE из соответствующих таблиц по seed-кодам
--   (entities/directions/categories/sources/funds.code, settings.key,
--   prodamus_product_mapping.product_pattern). Удалять в обратном порядке:
--   prodamus_product_mapping → settings → funds → sources → categories →
--   directions → entities.
--
-- Идемпотентность: ON CONFLICT DO NOTHING — миграцию можно прогонять повторно.

-- Юрлица
INSERT INTO entities (code, display_name, tax_regime) VALUES
  ('ip_eremyan', 'ИП Карина Еремян', 'usn_6'),
  ('ooo_assurgina', 'ООО Ассургина', 'usn_15'),
  ('personal', 'Личные средства', 'none')
ON CONFLICT (code) DO NOTHING;

-- Направления
INSERT INTO directions (code, display_name) VALUES
  ('course_dpo', 'Курс ДПО «Психология здоровья»'),
  ('metanoia', 'Клуб «Метанойя»'),
  ('common', 'Общие (без направления)')
ON CONFLICT (code) DO NOTHING;

-- Категории доходов
INSERT INTO categories (code, display_name, flow_type, accounting_type) VALUES
  ('revenue_course', 'Выручка: Курс ДПО', 'income', 'revenue'),
  ('revenue_club', 'Выручка: Клуб Метанойя', 'income', 'revenue'),
  ('revenue_other', 'Прочие поступления', 'income', 'revenue')
ON CONFLICT (code) DO NOTHING;

-- Категории расходов: прямые
INSERT INTO categories (code, display_name, flow_type, accounting_type) VALUES
  ('exp_video', 'Видеопроизводство', 'expense', 'direct'),
  ('exp_marketing', 'Реклама и маркетинг', 'expense', 'direct'),
  ('exp_contractors', 'Подрядчики', 'expense', 'direct'),
  ('exp_platform', 'Платформа / хостинг курса', 'expense', 'direct'),
  ('exp_materials', 'Учебные материалы', 'expense', 'direct'),
  ('exp_events', 'Мероприятия и встречи', 'expense', 'direct')
ON CONFLICT (code) DO NOTHING;

-- Категории расходов: операционные
INSERT INTO categories (code, display_name, flow_type, accounting_type) VALUES
  ('exp_software', 'ПО и подписки', 'expense', 'operational'),
  ('exp_communication', 'Связь и интернет', 'expense', 'operational'),
  ('exp_office', 'Офис и инфраструктура', 'expense', 'operational'),
  ('exp_bank', 'Банковские комиссии', 'expense', 'operational'),
  ('exp_accountant', 'Услуги бухгалтера', 'expense', 'operational'),
  ('exp_legal', 'Юридические услуги', 'expense', 'operational')
ON CONFLICT (code) DO NOTHING;

-- Налоги
INSERT INTO categories (code, display_name, flow_type, accounting_type) VALUES
  ('tax_usn', 'Налог УСН', 'expense', 'tax'),
  ('tax_insurance', 'Страховые взносы ИП', 'expense', 'tax'),
  ('tax_payroll', 'Зарплатные налоги (ООО)', 'expense', 'tax')
ON CONFLICT (code) DO NOTHING;

-- Кредиты и займы
INSERT INTO categories (code, display_name, flow_type, accounting_type) VALUES
  ('exp_loan_husband', 'Расходы на кредит мужа', 'expense', 'operational')
ON CONFLICT (code) DO NOTHING;

-- Личные
INSERT INTO categories (code, display_name, flow_type, accounting_type) VALUES
  ('exp_personal_food', 'Личное: еда и быт', 'expense', 'personal'),
  ('exp_personal_health', 'Личное: здоровье', 'expense', 'personal'),
  ('exp_personal_education', 'Личное: образование', 'expense', 'personal'),
  ('exp_personal_other', 'Личное: прочее', 'expense', 'personal')
ON CONFLICT (code) DO NOTHING;

-- Источники
INSERT INTO sources (code, display_name, source_type, currency, entity_id) VALUES
  ('rs_ip', 'Расчётный счёт ИП', 'rs_ip', 'RUB', (SELECT id FROM entities WHERE code='ip_eremyan')),
  ('rs_ooo', 'Расчётный счёт ООО', 'rs_ooo', 'RUB', (SELECT id FROM entities WHERE code='ooo_assurgina')),
  ('card_ip', 'Карта ИП', 'card_ip', 'RUB', (SELECT id FROM entities WHERE code='ip_eremyan')),
  ('card_personal_rub', 'Личная карта (РФ)', 'card_personal', 'RUB', (SELECT id FROM entities WHERE code='personal')),
  ('card_foreign_usd', 'Зарубежная карта (USD)', 'card_foreign', 'USD', (SELECT id FROM entities WHERE code='personal')),
  ('cash_rub', 'Наличные ₽', 'cash', 'RUB', (SELECT id FROM entities WHERE code='personal')),
  ('prodamus', 'Продамус (входящие)', 'prodamus', 'RUB', NULL),
  ('robokassa', 'Робокасса', 'prodamus', 'RUB', (SELECT id FROM entities WHERE code='ip_eremyan')),
  ('tochka', 'Точка', 'prodamus', 'RUB', (SELECT id FROM entities WHERE code='ooo_assurgina'))
ON CONFLICT (code) DO NOTHING;

-- Фонды (по умолчанию 6/10/15/69)
INSERT INTO funds (code, display_name, default_percentage, is_remainder, display_order) VALUES
  ('tax', '🏛 Налоги', 6.00, false, 1),
  ('reserve', '🛟 Резерв', 10.00, false, 2),
  ('development', '🚀 Развитие', 15.00, false, 3),
  ('personal', '💼 Личное', 69.00, true, 4)
ON CONFLICT (code) DO NOTHING;

-- Глобальные настройки
INSERT INTO settings (key, value, description) VALUES
  ('large_income_threshold', '10000000'::jsonb, 'Порог "крупного поступления" в копейках. По умолчанию 100 000 ₽.'),
  ('weekly_summary_enabled', 'true'::jsonb, 'Включить еженедельную сводку по понедельникам в 09:00 МСК'),
  ('alert_category_growth_threshold', '30'::jsonb, 'Алерт при росте категории > N% (от среднего за 4 недели)'),
  ('alert_tax_days_before', '14'::jsonb, 'За сколько дней до квартальной даты предупреждать о налогах'),
  ('loan_expense_target_percent', '10'::jsonb, 'Целевой минимальный процент дохода для расходов на кредит мужа'),
  ('claude_model', '"claude-sonnet-4-6"'::jsonb, 'Модель Anthropic для классификации'),
  ('claude_min_confidence_no_clarify', '0.85'::jsonb, 'Если confidence >= этого — не задавать уточняющих вопросов')
ON CONFLICT (key) DO NOTHING;

-- Стартовый mapping для Продамуса (примеры — Карина дополнит)
INSERT INTO prodamus_product_mapping (product_pattern, match_type, direction_id, entity_id) VALUES
  ('Курс ДПО', 'contains', (SELECT id FROM directions WHERE code='course_dpo'), (SELECT id FROM entities WHERE code='ip_eremyan')),
  ('Психология здоровья', 'contains', (SELECT id FROM directions WHERE code='course_dpo'), (SELECT id FROM entities WHERE code='ip_eremyan')),
  ('Метанойя', 'contains', (SELECT id FROM directions WHERE code='metanoia'), (SELECT id FROM entities WHERE code='ip_eremyan')),
  ('Метанойа', 'contains', (SELECT id FROM directions WHERE code='metanoia'), (SELECT id FROM entities WHERE code='ip_eremyan')),
  ('Германская новая медицина', 'contains', (SELECT id FROM directions WHERE code='metanoia'), (SELECT id FROM entities WHERE code='ip_eremyan'))
ON CONFLICT (product_pattern) DO NOTHING;
