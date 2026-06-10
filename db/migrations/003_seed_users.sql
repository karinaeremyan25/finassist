-- 003_seed_users.sql
-- Whitelist пользователей бота: Карина (owner) и бухгалтер (accountant).
-- Менеджеры (роль manager) добавляются вручную позже.
--
-- DOWN-логика (откат): DELETE FROM app_users WHERE telegram_id IN (1631024, 369918476);
--
-- Идемпотентность: ON CONFLICT (telegram_id) DO NOTHING.

INSERT INTO app_users (telegram_id, full_name, role) VALUES
  (1631024, 'Карина Еремян', 'owner'),
  (369918476, 'Бухгалтер', 'accountant')
ON CONFLICT (telegram_id) DO NOTHING;
