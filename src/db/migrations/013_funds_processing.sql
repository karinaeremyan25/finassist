-- 013_funds_processing.sql
-- Деньги «в обработке» по счёту из баланс-API Точки (поле Expected).
-- Точка отдаёт три значения: OpeningAvailable, ClosingAvailable, Expected.
-- Expected = сумма операций в обработке (ещё не проведены, но уже инициированы).
-- ClosingAvailable = OpeningAvailable − Expected (доступный остаток уже за вычетом
-- обработки). Сохраняем Expected со знаком: отрицательное = расход в обработке
-- (деньги уходят), положительное = доход в обработке.
ALTER TABLE funds ADD COLUMN IF NOT EXISTS processing_kopecks BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN funds.processing_kopecks IS
  'Деньги в обработке (Точка Expected) в копейках: <0 — расход в обработке, >0 — доход в обработке';
