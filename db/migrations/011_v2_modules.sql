-- 011_v2_modules.sql
-- SPEC_FinAssist_v2.1: ФОТ (employees), Контрагенты (contractors+invoices),
-- переклассификация (category_rules), деньги в пути (transactions.status),
-- AI-оркестратор (ai_commands).
--
-- Согласование со спекой:
--   - Спека предлагала ENABLE ROW LEVEL SECURITY и FK на auth.users — В ЭТОМ
--     ПРОЕКТЕ RLS ОТКЛЮЧЕНА (изоляция в Node.js-слое, CLAUDE.md), а Supabase Auth
--     не используется. Поэтому RLS не включаем, а аудит-FK ведём на app_users(id).
--   - company_id TEXT 'ip'|'ooo' — согласуется с ENTITY_IDS/префиксами счетов Точки.
--   - Все суммы — BIGINT (копейки). created_at/updated_at + триггер moddatetime.
--   - TEXT + CHECK вместо enum. UUID gen_random_uuid(). FK с явным ON DELETE.
--   - Все DDL идемпотентны (IF NOT EXISTS) — миграция безопасна на существующей БД.
--
-- DOWN:
--   DROP TABLE IF EXISTS ai_commands, category_rules, invoices, contractors, employees;
--   ALTER TABLE transactions
--     DROP COLUMN IF EXISTS employee_id, DROP COLUMN IF EXISTS contractor_id,
--     DROP COLUMN IF EXISTS invoice_id, DROP COLUMN IF EXISTS status;

-- ─────────────────────────────────────────────────────────────
-- employees — сотрудники для модуля ФОТ (US-101)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL CHECK (company_id IN ('ip', 'ooo')),
  full_name TEXT NOT NULL,
  position TEXT,
  salary_monthly BIGINT CHECK (salary_monthly IS NULL OR salary_monthly >= 0), -- копейки; NULL = не задана
  bank_details TEXT,
  -- match_pattern: подстрока для сопоставления имени контрагента из выписки → этот
  -- сотрудник (транзакции не хранят employee_id напрямую, см. SPEC §5 ФОТ).
  match_pattern TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_leave', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status) WHERE status = 'active';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_employees_updated_at') THEN
    CREATE TRIGGER trg_employees_updated_at
      BEFORE UPDATE ON employees
      FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);
  END IF;
END $$;

COMMENT ON TABLE employees IS 'Сотрудники для ФОТ. match_pattern сопоставляет имя контрагента выписки → сотрудник.';
COMMENT ON COLUMN employees.salary_monthly IS 'Оклад в копейках. NULL = не задан (остаток не считается, edge case #1).';

-- ─────────────────────────────────────────────────────────────
-- contractors — контрагенты (US-102)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contractors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL CHECK (company_id IN ('ip', 'ooo')),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  inn TEXT,
  -- match_pattern: подстрока для сопоставления контрагента выписки → запись.
  match_pattern TEXT,
  contractor_type TEXT NOT NULL DEFAULT 'company'
    CHECK (contractor_type IN ('individual', 'company', 'self_employed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contractors_company ON contractors(company_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contractors_updated_at') THEN
    CREATE TRIGGER trg_contractors_updated_at
      BEFORE UPDATE ON contractors
      FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- invoices — счета (только ООО, US-102 / edge case #5)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL DEFAULT 'ooo' CHECK (company_id = 'ooo'),
  invoice_number TEXT NOT NULL,
  contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  amount BIGINT NOT NULL CHECK (amount > 0), -- копейки
  description TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'paid', 'cancelled')),
  pdf_url TEXT,
  date_paid TIMESTAMPTZ,
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number_company
  ON invoices(company_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_contractor ON invoices(contractor_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoices_updated_at') THEN
    CREATE TRIGGER trg_invoices_updated_at
      BEFORE UPDATE ON invoices
      FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- category_rules — выученные правила переклассификации (US-103)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS category_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL company_id = правило применимо к обоим юрлицам.
  company_id TEXT CHECK (company_id IS NULL OR company_id IN ('ip', 'ooo')),
  keyword TEXT NOT NULL,                  -- нормализованная подстрока (lower-case)
  target_pnl_category TEXT NOT NULL,
  confidence NUMERIC(3, 2) NOT NULL DEFAULT 0.80 CHECK (confidence >= 0 AND confidence <= 1),
  -- сколько раз правило подтверждалось перемещением (для приоритета)
  hit_count INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Одно правило на (keyword, company). Новое перемещение перезаписывает категорию
-- (edge case #3: новое правило > старое).
CREATE UNIQUE INDEX IF NOT EXISTS idx_category_rules_keyword_company
  ON category_rules(keyword, COALESCE(company_id, ''));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_category_rules_updated_at') THEN
    CREATE TRIGGER trg_category_rules_updated_at
      BEFORE UPDATE ON category_rules
      FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);
  END IF;
END $$;

COMMENT ON TABLE category_rules IS 'Выученные правила: при перемещении операции в категорию сохраняем keyword→category, классификатор применяет их детерминированно.';

-- ─────────────────────────────────────────────────────────────
-- ai_commands — лог голосовых/текстовых команд оркестратора (US-105)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  command_text TEXT NOT NULL,
  command_type TEXT NOT NULL DEFAULT 'query'
    CHECK (command_type IN ('create_invoice', 'create_payment', 'reclassify', 'query', 'unknown')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executed', 'failed', 'rejected')),
  ai_response JSONB,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_commands_user ON ai_commands(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_commands_status ON ai_commands(status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ai_commands_updated_at') THEN
    CREATE TRIGGER trg_ai_commands_updated_at
      BEFORE UPDATE ON ai_commands
      FOR EACH ROW EXECUTE PROCEDURE moddatetime(updated_at);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- transactions: связи и статус «деньги в пути» (US-104)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contractor_id UUID REFERENCES contractors(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL;
-- tx_status (не «status», чтобы не пересекаться с возможными чтениями): completed = в выписке,
-- pending = деньги в пути (Prodamus/Lava до зачисления), returned = возврат.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_status TEXT NOT NULL DEFAULT 'completed'
  CHECK (tx_status IN ('completed', 'pending', 'returned'));

CREATE INDEX IF NOT EXISTS idx_transactions_tx_status ON transactions(tx_status) WHERE tx_status <> 'completed';
CREATE INDEX IF NOT EXISTS idx_transactions_employee ON transactions(employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_contractor ON transactions(contractor_id) WHERE contractor_id IS NOT NULL;

COMMENT ON COLUMN transactions.tx_status IS 'completed=в выписке, pending=деньги в пути, returned=возврат. P&L нетто = только completed.';
