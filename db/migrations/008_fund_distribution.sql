-- 008_fund_distribution.sql
-- Плановые проценты распределения дохода по фондам (система Карины):
-- Благодарность 65%, Кредиты 10%, Налог 8%, Резерв 7%, Земля 5% = 95%, Прибыль 5%.
-- Используются для диаграммы «Распределение выручки» на главной.
--
-- DOWN: ALTER TABLE funds DROP COLUMN IF EXISTS distribution_percent;

ALTER TABLE funds ADD COLUMN IF NOT EXISTS distribution_percent NUMERIC(5,2);

UPDATE funds SET distribution_percent = 65 WHERE code = 'gratitude';
UPDATE funds SET distribution_percent = 10 WHERE code = 'credit';
UPDATE funds SET distribution_percent = 8  WHERE code = 'tax_ip';
UPDATE funds SET distribution_percent = 7  WHERE code = 'reserve_ip';
UPDATE funds SET distribution_percent = 5  WHERE code = 'land';

COMMENT ON COLUMN funds.distribution_percent IS 'Плановый % распределения дохода в фонд (для диаграммы на главной).';
