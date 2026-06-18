-- 010_add_lava_source.sql
-- Lava.top как четвёртый источник дохода (вебхук push-модель).
-- entity_id по умолчанию — ИП (fallback для немаппированных офферов);
-- конкретное юрлицо/направление определяется по product.id в сервисе lava.ts.

-- 1. Источник Lava.top
INSERT INTO sources (code, display_name, entity_id, is_active, sync_enabled)
VALUES (
  'lava',
  'Lava.top',
  (SELECT id FROM entities WHERE code = 'IP' LIMIT 1),
  true,
  false   -- push-модель (вебхук), поллингом не синкаем
)
ON CONFLICT (code) DO NOTHING;

-- 2. Доходные категории Lava.top (детализация в P&L / Отчётах)
INSERT INTO categories (code, display_name, flow_type, accounting_type, is_active)
VALUES
  ('lava_course', 'Lava.top — Курс ДПО',      'income', NULL, true),
  ('lava_club',   'Lava.top — Клуб Метанойя', 'income', NULL, true)
ON CONFLICT (code) DO NOTHING;
