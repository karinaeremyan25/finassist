-- 006_tochka_robokassa.sql
-- Источники, фонды и связи для интеграции Точки и Робокассы в Mini App.
-- См. feature-spec-tochka-robokassa-miniapp.md §7. Под РЕАЛЬНУЮ схему БД.
--
-- DOWN:
--   ALTER TABLE fund_transactions DROP COLUMN IF EXISTS source_transaction_id;
--   ALTER TABLE funds DROP COLUMN IF EXISTS tochka_account_id;
--   DELETE FROM sources WHERE code IN ('robokassa','tochka');
--   DELETE FROM funds WHERE code IN ('gratitude','credit','land');
--   DELETE FROM categories WHERE code IN ('internal_transfer','acquiring_settlement');

-- 1. Источники Робокассы и Точки (в реальной БД их не было)
INSERT INTO sources (code, display_name, is_active) VALUES
  ('robokassa', 'Робокасса', true),
  ('tochka',    'Точка (счёт)', true)
ON CONFLICT (code) DO NOTHING;

-- 2. Недостающие фонды (есть в остатках Точки, не было в БД).
--    entity_id оставляем NULL (общие фонды); balance в копейках.
INSERT INTO funds (name, code, balance, is_active) VALUES
  ('Фонд «Благодарность»', 'gratitude', 0, true),
  ('Фонд «Кредиты»',       'credit',    0, true),
  ('Фонд «Земля»',         'land',      0, true)
ON CONFLICT (code) DO NOTHING;

-- 3. Связь движения по фонду с расходной операцией («куда ушли деньги фонда»).
ALTER TABLE fund_transactions
  ADD COLUMN IF NOT EXISTS source_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;

-- 4. Соответствие фонд ↔ счёт-копилка Точки (для прямой синхронизации балансов).
ALTER TABLE funds
  ADD COLUMN IF NOT EXISTS tochka_account_id TEXT;

-- 5. Служебные категории: внутренние переводы (фонд) и зачисление эквайринга
--    (чтобы не задваивать доход). accounting_type оставляем NULL (nullable).
INSERT INTO categories (code, display_name, flow_type, is_active) VALUES
  ('internal_transfer',    'Внутренний перевод (фонд)', 'expense', true),
  ('acquiring_settlement', 'Зачисление эквайринга',     'income',  true)
ON CONFLICT (code) DO NOTHING;

COMMENT ON COLUMN fund_transactions.source_transaction_id IS 'Расходная транзакция, на которую ушли деньги фонда (куда/зачем).';
COMMENT ON COLUMN funds.tochka_account_id IS 'ID счёта-копилки в Точке для прямой синхронизации баланса фонда.';
