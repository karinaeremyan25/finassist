-- 009_pnl_classification.sql
-- Поля для AI-классификации транзакций и P&L (feature-spec-pnl.md).
-- Реальная схема уже имеет category_id (FK), needs_classification, needs_owner_review.
-- Добавляем отдельные поля под классификатор P&L (бизнес/личные категории-коды).
--
-- DOWN:
--   ALTER TABLE transactions DROP COLUMN IF EXISTS pnl_category, DROP COLUMN IF EXISTS counterparty,
--     DROP COLUMN IF EXISTS is_personal, DROP COLUMN IF EXISTS classifier_confidence,
--     DROP COLUMN IF EXISTS needs_review, DROP COLUMN IF EXISTS category_overridden_by,
--     DROP COLUMN IF EXISTS category_overridden_at;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS counterparty TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pnl_category TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS classifier_confidence NUMERIC(3,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_overridden_by UUID REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_overridden_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transactions_pnl_category ON transactions(pnl_category);
CREATE INDEX IF NOT EXISTS idx_transactions_is_personal ON transactions(is_personal);
CREATE INDEX IF NOT EXISTS idx_transactions_needs_review ON transactions(needs_review) WHERE needs_review = true;

COMMENT ON COLUMN transactions.counterparty IS 'Имя контрагента из выписки (для классификации и отображения).';
COMMENT ON COLUMN transactions.pnl_category IS 'Категория классификатора P&L: payroll|marketing|loan|subscriptions|tax|other_business|personal_*';
COMMENT ON COLUMN transactions.is_personal IS 'true = личная трата собственника (не влияет на прибыль бизнеса).';
COMMENT ON COLUMN transactions.needs_review IS 'true = классификатор не уверен (confidence<0.7), бухгалтер проверяет.';
