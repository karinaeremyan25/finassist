-- 001_init.sql
-- Основная схема FinAssist: справочники, транзакции, фонды, аудит, сессии.
--
-- DOWN-логика (откат): DROP TABLE в обратном порядке зависимостей —
--   alert_log, bot_sessions, settings, fund_transactions, funds,
--   prodamus_product_mapping, transaction_edits, transactions, fx_rates,
--   sources, categories, manager_directions, directions, entities, app_users;
--   затем DROP EXTENSION moddatetime (pgcrypto обычно оставляют).
--
-- Соглашения:
--   - Все денежные суммы — BIGINT (копейки). float/decimal для денег запрещены.
--   - Отрицательные суммы допускаются ТОЛЬКО в fund_transactions (списания).
--   - Все даты — TIMESTAMPTZ (UTC), кроме occurred_at (DATE — дата операции).
--   - Все id — UUID DEFAULT gen_random_uuid().
--   - created_at/updated_at + триггер moddatetime на каждой изменяемой таблице.
--   - Текстовые перечисления — TEXT + CHECK (... IN (...)), не enum-типы.
--   - Soft delete транзакций — deleted_at TIMESTAMPTZ.
--   - RLS отключена: изоляция данных в Node.js-слое (repositories).

-- Расширения
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "moddatetime";

-- ─────────────────────────────────────────────────────────────
-- Таблица: app_users
-- Whitelist пользователей с привязкой telegram_id к роли.
-- Заполняется вручную при деплое (см. seed.sql).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'accountant', 'manager')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_users_telegram_id ON app_users(telegram_id);
CREATE INDEX idx_app_users_role ON app_users(role) WHERE is_active = true;

CREATE TRIGGER trg_app_users_updated_at
  BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

COMMENT ON TABLE app_users IS 'Whitelist пользователей бота. telegram_id = первичный ключ доступа.';

-- ─────────────────────────────────────────────────────────────
-- Таблица: entities
-- Юридические лица (ИП и ООО Ассургина).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('ip_eremyan', 'ooo_assurgina', 'personal')),
  display_name TEXT NOT NULL,
  tax_regime TEXT CHECK (tax_regime IN ('usn_6', 'usn_15', 'osno', 'patent', 'none')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_entities_updated_at
  BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

COMMENT ON TABLE entities IS 'ИП Карина Еремян, ООО Ассургина, plus виртуальный "personal" для личных средств.';

-- ─────────────────────────────────────────────────────────────
-- Таблица: directions
-- Направления бизнеса (Курс ДПО, Метанойя).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE directions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('course_dpo', 'metanoia', 'common')),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_directions_updated_at
  BEFORE UPDATE ON directions
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

COMMENT ON TABLE directions IS 'Направления бизнеса. "common" — общие операционные расходы, не привязанные к направлению.';

-- ─────────────────────────────────────────────────────────────
-- Таблица: manager_directions
-- M:N связь — какой manager какие направления видит.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE manager_directions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  direction_id UUID NOT NULL REFERENCES directions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, direction_id)
);

CREATE INDEX idx_manager_directions_user ON manager_directions(user_id);
CREATE INDEX idx_manager_directions_direction ON manager_directions(direction_id);

COMMENT ON TABLE manager_directions IS 'Какие направления доступны роли manager. Owner и accountant видят все направления без записи в этой таблице.';

-- ─────────────────────────────────────────────────────────────
-- Таблица: categories
-- Категории расходов и доходов с бухгалтерской классификацией.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  flow_type TEXT NOT NULL CHECK (flow_type IN ('income', 'expense')),
  accounting_type TEXT NOT NULL CHECK (accounting_type IN (
    'direct',         -- прямые расходы по направлению
    'operational',    -- общие операционные
    'tax',            -- налоги и сборы
    'personal',       -- личные расходы собственника
    'revenue'         -- выручка (для income)
  )),
  parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_categories_flow_type ON categories(flow_type) WHERE is_active = true;
CREATE INDEX idx_categories_accounting_type ON categories(accounting_type);
CREATE INDEX idx_categories_parent ON categories(parent_id);

CREATE TRIGGER trg_categories_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

COMMENT ON COLUMN categories.accounting_type IS 'Бухгалтерская классификация для P&L: direct=прямые по направлению, operational=общие, tax=налоги, personal=личное собственника, revenue=выручка';

-- ─────────────────────────────────────────────────────────────
-- Таблица: sources
-- Источники денег (расчётные счета, карты, наличные).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'rs_ip',           -- расчётный счёт ИП
    'rs_ooo',          -- расчётный счёт ООО
    'card_ip',         -- карта ИП (бизнес)
    'card_personal',   -- личная карта РФ
    'card_foreign',    -- зарубежная карта
    'cash',            -- наличные
    'prodamus'         -- виртуальный источник для входящих с Продамуса
  )),
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency IN ('RUB', 'USD', 'EUR', 'KZT', 'OTHER')),
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sources_type ON sources(source_type);
CREATE INDEX idx_sources_entity ON sources(entity_id);

CREATE TRIGGER trg_sources_updated_at
  BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

-- ─────────────────────────────────────────────────────────────
-- Таблица: fx_rates
-- Курсы валют ЦБ РФ. Подгружаются ежедневно cron-задачей.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE fx_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_date DATE NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'KZT')),
  rate_to_rub NUMERIC(12, 4) NOT NULL,
  source TEXT NOT NULL DEFAULT 'cbr.ru',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rate_date, currency)
);

CREATE INDEX idx_fx_rates_date_currency ON fx_rates(rate_date DESC, currency);

COMMENT ON COLUMN fx_rates.rate_to_rub IS 'Курс к рублю. Например, USD 92.5430 = 1 USD = 92.5430 RUB.';

-- ─────────────────────────────────────────────────────────────
-- Таблица: transactions
-- Главная таблица — все финансовые операции.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Тип и сумма
  flow_type TEXT NOT NULL CHECK (flow_type IN ('income', 'expense')),
  amount BIGINT NOT NULL CHECK (amount > 0),  -- в копейках/центах исходной валюты
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency IN ('RUB', 'USD', 'EUR', 'KZT', 'OTHER')),
  amount_rub BIGINT NOT NULL CHECK (amount_rub > 0),  -- пересчёт в рубли (копейки)
  fx_rate NUMERIC(12, 4),  -- применённый курс (NULL для RUB)

  -- Классификация
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  direction_id UUID REFERENCES directions(id) ON DELETE SET NULL,  -- NULL = не привязано к направлению (общие расходы)
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,

  -- Метаданные
  occurred_at DATE NOT NULL,  -- дата операции
  description TEXT,
  external_id TEXT,  -- payment_id из Продамуса для дедупликации

  -- Audit
  created_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  needs_classification BOOLEAN NOT NULL DEFAULT false,
  needs_owner_review BOOLEAN NOT NULL DEFAULT false,
  ai_confidence NUMERIC(3, 2),  -- 0.00 — 1.00, NULL если без AI
  raw_input TEXT,  -- исходный текст/расшифровка голосового
  raw_ai_response JSONB,  -- что вернул Claude

  -- Soft delete
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES app_users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Дедупликация Продамуса: один external_id может быть только раз
CREATE UNIQUE INDEX idx_transactions_external_id_unique
  ON transactions(external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_transactions_occurred_at ON transactions(occurred_at DESC);
CREATE INDEX idx_transactions_entity ON transactions(entity_id);
CREATE INDEX idx_transactions_direction ON transactions(direction_id);
CREATE INDEX idx_transactions_flow_type ON transactions(flow_type);
CREATE INDEX idx_transactions_verified ON transactions(verified) WHERE verified = false AND deleted_at IS NULL;
CREATE INDEX idx_transactions_created_by ON transactions(created_by);
CREATE INDEX idx_transactions_active ON transactions(occurred_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

COMMENT ON COLUMN transactions.amount IS 'Сумма в минимальной единице исходной валюты (копейки для RUB, центы для USD/EUR)';
COMMENT ON COLUMN transactions.amount_rub IS 'Сумма в копейках после пересчёта в RUB по курсу ЦБ на дату operation';
COMMENT ON COLUMN transactions.external_id IS 'payment_id из Продамуса для дедупликации';

-- ─────────────────────────────────────────────────────────────
-- Таблица: transaction_edits
-- Audit log изменений транзакций.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE transaction_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  edited_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  edit_type TEXT NOT NULL CHECK (edit_type IN ('create', 'update', 'verify', 'delete', 'restore')),
  before_json JSONB,
  after_json JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transaction_edits_transaction ON transaction_edits(transaction_id, created_at DESC);
CREATE INDEX idx_transaction_edits_user ON transaction_edits(edited_by);

-- ─────────────────────────────────────────────────────────────
-- Таблица: prodamus_product_mapping
-- Правила: какой product_name → какое направление.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE prodamus_product_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_pattern TEXT NOT NULL UNIQUE,  -- регулярка или подстрока
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'regex', 'exact')),
  direction_id UUID NOT NULL REFERENCES directions(id) ON DELETE RESTRICT,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prodamus_mapping_active ON prodamus_product_mapping(is_active) WHERE is_active = true;

CREATE TRIGGER trg_prodamus_mapping_updated_at
  BEFORE UPDATE ON prodamus_product_mapping
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

COMMENT ON TABLE prodamus_product_mapping IS 'Правила соответствия product_name из Продамуса → direction_id. Проверяются по порядку: exact → regex → contains.';

-- ─────────────────────────────────────────────────────────────
-- Таблица: funds
-- Виртуальные фонды накоплений (налоги, резерв, развитие, личное).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('tax', 'reserve', 'development', 'personal')),
  display_name TEXT NOT NULL,
  default_percentage NUMERIC(5, 2) NOT NULL CHECK (default_percentage >= 0 AND default_percentage <= 100),
  is_remainder BOOLEAN NOT NULL DEFAULT false,  -- true для personal — остаток после остальных
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_funds_updated_at
  BEFORE UPDATE ON funds
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

-- Гарантия: только один фонд может быть is_remainder = true
CREATE UNIQUE INDEX idx_funds_only_one_remainder
  ON funds((1)) WHERE is_remainder = true;

-- ─────────────────────────────────────────────────────────────
-- Таблица: fund_transactions
-- Движения по фондам (зачисления и списания).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE fund_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE RESTRICT,
  amount BIGINT NOT NULL,  -- может быть отрицательным (списание)
  fund_transaction_type TEXT NOT NULL CHECK (fund_transaction_type IN ('allocation', 'withdrawal', 'manual_adjust')),
  source_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,  -- если allocation от поступления
  occurred_at DATE NOT NULL,
  description TEXT,
  created_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fund_transactions_fund ON fund_transactions(fund_id, occurred_at DESC);
CREATE INDEX idx_fund_transactions_source ON fund_transactions(source_transaction_id);

COMMENT ON COLUMN fund_transactions.amount IS 'Положительное = зачисление, отрицательное = списание. В копейках RUB.';

-- ─────────────────────────────────────────────────────────────
-- Таблица: settings
-- Глобальные настройки бота (key-value).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

-- ─────────────────────────────────────────────────────────────
-- Таблица: bot_sessions
-- FSM-состояния диалогов (на случай рестарта бота).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE bot_sessions (
  telegram_id BIGINT PRIMARY KEY,
  state TEXT NOT NULL,  -- например 'awaiting_prodamus_file', 'verifying_transactions'
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_sessions_expires ON bot_sessions(expires_at);

CREATE TRIGGER trg_bot_sessions_updated_at
  BEFORE UPDATE ON bot_sessions
  FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);

-- ─────────────────────────────────────────────────────────────
-- Таблица: alert_log
-- Журнал отправленных алертов (чтобы не дублировать).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE alert_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL CHECK (alert_type IN ('weekly_summary', 'tax_warning', 'category_growth', 'low_reserve')),
  recipient_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('sent', 'failed', 'retried'))
);

CREATE INDEX idx_alert_log_recipient ON alert_log(recipient_user_id, sent_at DESC);
CREATE INDEX idx_alert_log_type ON alert_log(alert_type, sent_at DESC);
