-- 004_add_last_seen.sql
-- Добавляет app_users.last_seen для экрана многопользовательского доступа
-- и аудита Mini App (feature-spec-mini-app-ai-agent.md §2).
-- Обновляется при успешной авторизации Web App сессии (src/server/auth.ts).

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

COMMENT ON COLUMN app_users.last_seen IS 'Последняя активность пользователя в Mini App (UTC). NULL — ещё не заходил.';
