-- 012_contractor_requisites.sql
-- Банковские реквизиты контрагента для платёжек (PDF и будущая оплата через Точку).
-- Идемпотентно. DOWN: ALTER TABLE contractors DROP COLUMN IF EXISTS bank_account, DROP COLUMN IF EXISTS bik.

ALTER TABLE contractors ADD COLUMN IF NOT EXISTS bank_account TEXT;  -- расчётный счёт получателя
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS bik TEXT;           -- БИК банка получателя

COMMENT ON COLUMN contractors.bank_account IS 'Расчётный счёт получателя (для платёжек).';
COMMENT ON COLUMN contractors.bik IS 'БИК банка получателя (для платёжек).';
