-- 007_plans_and_users.sql
-- 1) Планы доход/расход по месяцам (min/avg/max) для дашборда «план/факт/%».
-- 2) Разрешаем добавлять пользователей по @username до их первого входа
--    (telegram_id заполнится при первом открытии приложения).
--
-- DOWN:
--   DROP TABLE IF EXISTS monthly_plans;
--   (telegram_id обратно NOT NULL — только если нет NULL-строк)

-- Пользователей можно завести заранее по нику (telegram_id придёт при первом входе)
ALTER TABLE app_users ALTER COLUMN telegram_id DROP NOT NULL;

-- Планы по месяцам (суммы в копейках, min/avg/max; avg/max — опционально)
CREATE TABLE IF NOT EXISTS monthly_plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year_month   TEXT NOT NULL UNIQUE,          -- '2026-06'
  income_min   BIGINT,
  income_avg   BIGINT,
  income_max   BIGINT,
  expense_min  BIGINT,
  expense_avg  BIGINT,
  expense_max  BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE monthly_plans IS 'Плановые показатели доход/расход по месяцам для дашборда «план/факт/%».';
