# FinAssist — Расширенная спецификация (v2.1)

> **Версия:** 2.1 (Расширение существующей системы)  
> **Дата:** 21 июня 2026  
> **Статус:** Интеграция с существующей архитектурой  
> **Основа:** SESSION_HANDOFF от 2026-06-20

---

## 0. Контекст

FinAssist **уже работает** на Vercel (`https://finassist-virid.vercel.app`, repo `github.com/karinaeremyan25/finassist`).

**Существующее:**
- ✅ Архитектура: catch-all router (`api/router.ts`), Supabase + postgres.js
- ✅ Интеграции: Точка (авто-синк 2×/день), Prodamus (webhook), Lava.top (webhook)
- ✅ Модули: P&L, Фонды (9 счетов), Отчёты, Дашборд, AI-наставник, Админка
- ✅ 2 юрлица: ИП (УСН 6%) + ООО (УСН 15%)

**Что добавляем (из требований Карины):**
1. **ФОТ модуль** — управление зарплатами (25 сотрудников) + 4 физ карты
2. **Контрагенты** — счета, авансы, остатки задолженности, клик → чек из Точки
3. **Категоризация + переклассификация** — AI категоризирует, пользователь может переместить
4. **Деньги в пути** — отдельно показать поступления/расходы в обработке
5. **AI-оркестратор** — голосовые команды (счета, платёжки, переклассификация)

---

## 1. БЛОК 1: User Stories (НОВЫЕ)

### US-101: ФОТ — управление зарплатами сотрудников

**Как** Карина,  
**я хочу** видеть по каждому сотруднику: зарплату, выплаченное за месяц, остаток,  
**чтобы** контролировать ФОТ.

**Сценарий:**
1. Раздел "ФОТ" → таблица сотрудников (ФИО, должность, зарплата/мес, выплачено май, выплачено июнь, остаток)
2. Кликаю на сотрудника → видим все его операции (зарплаты, авансы, командировки)
3. Кликаю на операцию → чек из Точки (если платёж) или описание (если ручной ввод)
4. Фильтр по сотруднику работает везде в приложении

**Критерий приёмки:**
- [ ] Таблица грузится < 1 сек
- [ ] Фильтр по сотруднику работает на всех экранах (Отчёты, P&L, Фонды)
- [ ] Клик на операцию показывает источник (tochka_transaction_id → чек Точки)
- [ ] Зарплата считается правильно (с авансами, доп выплатами)

---

### US-102: Контрагенты — счета и авансы

**Как** Карина,  
**я хочу** видеть по контрагенту: выставленные счета, полученные платежи, остаток задолженности, даты,  
**чтобы** контролировать расчёты.

**Сценарий:**
1. Раздел "Контрагенты" → список (Гайнетдинова, Вася, и т.д.)
2. Кликаю на Гайнетдинову → видим:
   - Счёт #1: 77.2K (статус: ожидание)
   - Счёт #2: 25K (статус: оплачен 15.06)
   - Авансы/платежи: 12K (15.06), остаток 18K
3. Кликаю на платёж "12K от 15.06" → чек из Точки
4. Фильтр: "покажи контрагентов с остатком"

**Критерий приёмки:**
- [ ] Контрагент группирует счета + платежи + авансы
- [ ] Остаток = (сумма счетов) - (сумма платежей)
- [ ] Клик на платёж → tochka_transaction_id → чек Точки
- [ ] Дата платежа видна и фильтруется

---

### US-103: Переклассификация расходов (AI учится)

**Как** Карина или бухгалтер,  
**я хочу** видеть расходы категоризированные AI и иметь возможность переместить операцию в другую категорию,  
**чтобы** исправлять ошибки и обучать систему.

**Сценарий:**
1. Раздел "Расходы" → список операций с категориями (ФОТ, Реклама, Прочее)
2. Вижу: "Коммунизм" — 5K — категория "Прочее"
3. Понимаю: это ФОТ (зарплата Токарь)
4. Клик на операцию → кнопка "Переместить"
5. Выбираю "ФОТ"
6. Система: "Учла! Со следующего раза буду сразу в ФОТ"

**Критерий приёмки:**
- [ ] Каждая операция имеет pnl_category (ФОТ, Реклама, Налоги, Подписки, Прочее)
- [ ] Клик → "Переместить в другую категорию"
- [ ] После перемещения AI запоминает правило
- [ ] Похожие операции AI предлагает в новую категорию

---

### US-104: Деньги в пути (в обработке)

**Как** Карина,  
**я хочу** видеть отдельно деньги, которые в обработке (ещё не пришли, ещё не списали),  
**чтобы** знать реальное сальдо.

**Сценарий:**
1. На главной P&L вижу:
   - Доход: 500K
   - в т.ч. **в пути:** 50K (ещё не пришли) ← НОВОЕ
   - Реальный доход: 450K
2. Расходы: 200K
   - в т.ч. **в пути:** 30K (ещё не списали) ← НОВОЕ
   - Реальные расходы: 170K

**Критерий приёмки:**
- [ ] В пути отображается отдельно (доходы + расходы)
- [ ] Операции в обработке помечены как "pending"
- [ ] P&L считается ДВУМЯ способами: брутто (с в пути) и нетто (без)
- [ ] Налог считается по нетто (без денег в пути)

---

### US-105: AI-оркестратор (голосовые команды)

**Как** Карина,  
**я хочу** отправить команду (голос/текст), и AI её выполнит,  
**чтобы** быстро создавать счета, платёжки, переклассифицировать.

**Сценарий 1: Счёт**
- Команда: "Счёт на Гайнетдинову 25K"
- AI: "Создаю счёт на Гайнетдинова Диана, 25000 руб"
- Результат: PDF счёта (статус: draft) → можно отправить

**Сценарий 2: Платёжное поручение**
- Команда: "Платёжка в ФНС на налог"
- AI считает налог (Авто-УСН: доход минус комиссии × 8%)
- Результат: PDF платёжка → можно загрузить в Точку

**Сценарий 3: Переклассификация**
- Команда: "Перемести 5K из прочего в ФОТ"
- AI находит операцию, перемещает, запоминает правило

**Критерий приёмки:**
- [ ] Команда обрабатывается < 3 сек
- [ ] Счета генерируются правильно (номер, реквизиты)
- [ ] Платёжки считают налог по формуле: (доход - комиссии) × 8%
- [ ] Все команды логируются (ai_commands таблица)

---

## 2. БЛОК 2: Data Model (ИЗМЕНЕНИЯ К СУЩЕСТВУЮЩЕМУ)

### Таблица: employees (НОВАЯ — для ФОТ)

```sql
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL, -- 'ip' или 'ooo' (по префиксу счёта)
  full_name TEXT NOT NULL,
  position TEXT,
  salary_monthly BIGINT NOT NULL, -- копейки
  bank_details TEXT, -- реквизиты счёта для выплат
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_leave', 'dismissed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_employees_company ON employees(company_id);
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
```

---

### Таблица: contractors (НОВАЯ — для контрагентов)

```sql
CREATE TABLE contractors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL, -- 'ip' или 'ooo'
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  contractor_type TEXT NOT NULL CHECK (contractor_type IN ('individual', 'company', 'self_employed')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contractors_company ON contractors(company_id);
ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;
```

---

### Таблица: invoices (НОВАЯ — для счетов, только ООО)

```sql
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL DEFAULT 'ooo',
  invoice_number TEXT NOT NULL, -- "1", "2", "3"...
  contractor_id UUID NOT NULL REFERENCES contractors(id),
  amount BIGINT NOT NULL, -- копейки
  description TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'cancelled')),
  pdf_url TEXT, -- путь в Supabase Storage
  date_created TIMESTAMPTZ DEFAULT NOW(),
  date_paid TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_company ON invoices(company_id);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
```

---

### Таблица: category_rules (НОВАЯ — для переклассификации)

```sql
CREATE TABLE category_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL, -- 'ip' или 'ooo'
  keyword TEXT NOT NULL, -- "коммунизм", "токарь"
  target_pnl_category TEXT NOT NULL, -- целевая категория
  confidence FLOAT DEFAULT 0.8, -- 0-1
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_category_rules_company ON category_rules(company_id);
```

---

### Таблица: ai_commands (НОВАЯ — логирование голосовых команд)

```sql
CREATE TABLE ai_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  command_text TEXT NOT NULL,
  command_type TEXT NOT NULL, -- 'create_invoice', 'create_payment', 'reclassify', 'query'
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'failed', 'rejected')),
  ai_response JSONB, -- результат AI
  user_approval BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_commands_company ON ai_commands(company_id);
```

---

### Изменения в существующую таблицу: transactions

```sql
-- ДОБАВИТЬ поля (если нет):
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id),
ADD COLUMN IF NOT EXISTS contractor_id UUID REFERENCES contractors(id),
ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES invoices(id),
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'pending', 'returned'));

-- Поле tochka_transaction_id — уже есть (для клика на чек из Точки)
```

---

## 3. БЛОК 3: API Endpoints (НОВЫЕ МАРШРУТЫ)

### Архитектура API

**Все новые эндпоинты добавляются ТОЛЬКО в `src/server/index.ts → buildRouter()`**  
**Нет новых файлов в `/api`**

---

### Группа: /employees (ФОТ)

#### `GET /employees?company=ip`
Получить список сотрудников с суммами выплат.

**Ответ:**
```json
{
  "data": [
    {
      "id": "uuid-1",
      "full_name": "Токарь Дарья",
      "position": "Куратор",
      "salary_monthly": 3210000,
      "total_paid_may": 1605000,
      "total_paid_june": 1605000,
      "balance": 1605000
    }
  ]
}
```

---

#### `GET /employees/{id}/transactions`
Все операции по сотруднику.

**Ответ:**
```json
{
  "data": [
    {
      "id": "tx-uuid",
      "amount": 500000,
      "pnl_category": "fot",
      "description": "Авансо май",
      "date_transaction": "2026-05-15T00:00:00Z",
      "tochka_transaction_id": "12345" // клик → чек
    }
  ]
}
```

---

### Группа: /contractors (Контрагенты)

#### `GET /contractors?company=ooo`
Список контрагентов с остатками.

**Ответ:**
```json
{
  "data": [
    {
      "id": "uuid-c1",
      "name": "Гайнетдинова Диана",
      "total_invoiced": 10220000,
      "total_paid": 2700000,
      "balance_owed": 7520000,
      "invoices": [...],
      "payments": [...]
    }
  ]
}
```

---

#### `POST /invoices/generate`
Создать счёт.

**Запрос:**
```json
{
  "contractor_id": "uuid-c1",
  "amount": 2500000,
  "description": "Консультационные услуги",
  "due_date": "2026-06-21"
}
```

**Ответ:**
```json
{
  "id": "inv-uuid",
  "invoice_number": "2",
  "status": "draft",
  "pdf_url": "https://storage.../inv-2.pdf"
}
```

---

### Группа: /transactions/categorize (Категоризация)

#### `PATCH /transactions/{id}/pnl_category`
Переместить операцию в другую категорию.

**Запрос:**
```json
{
  "new_pnl_category": "fot"
}
```

**Ответ:**
```json
{
  "id": "tx-uuid",
  "pnl_category": "fot",
  "user_corrected": true,
  "rule_created": true // AI запомнил правило
}
```

---

### Группа: /ai/commands (AI-оркестратор)

#### `POST /ai/commands`
Отправить голосовую команду.

**Запрос:**
```json
{
  "command": "Счёт на Гайнетдинову 25K",
  "command_type": "create_invoice"
}
```

**Ответ:**
```json
{
  "id": "cmd-uuid",
  "status": "pending",
  "ai_response": {
    "type": "create_invoice",
    "contractor": { "id": "uuid-c1", "name": "Гайнетдинова Диана" },
    "amount": 2500000,
    "preview": "Создам счёт на Гайнетдинову, 25000 руб. →"
  },
  "needs_approval": true
}
```

---

#### `POST /ai/commands/{id}/approve`
Одобрить команду AI.

**Запрос:**
```json
{
  "approved": true
}
```

**Ответ:**
```json
{
  "status": "executed",
  "result": {
    "invoice_id": "inv-uuid",
    "pdf_url": "https://storage.../inv-2.pdf"
  }
}
```

---

### Группа: /reports (Отчёты — ИЗМЕНЕНИЯ)

#### `GET /reports/p-l?company=ip&include_in_transit=true`
P&L с отдельной строкой "в пути".

**Ответ:**
```json
{
  "income": {
    "total": 50000000,
    "in_transit": 5000000,
    "real_income": 45000000
  },
  "expenses": {
    "total": 15000000,
    "in_transit": 2000000,
    "real_expenses": 13000000
  }
}
```

---

## 4. БЛОК 4: UI/UX (НОВЫЕ ЭКРАНЫ / ИЗМЕНЕНИЯ)

### Экран: Employees (ФОТ) — НОВЫЙ
**Путь:** `/employees`

**Компоненты:**
- Таблица (ФИО, должность, зарплата/мес, выплачено май, выплачено июнь, остаток)
- Фильтр по статусу (active, on_leave, dismissed)
- Клик на сотрудника → drawer с его операциями

**Действия:**
- Фильтр "Активные" по умолчанию
- Клик на операцию → если tochka_transaction_id, показать чек из Точки

---

### Экран: Contractors — НОВЫЙ
**Путь:** `/contractors`

**Компоненты:**
- Карточки контрагентов (имя, выставлено счетов, оплачено, остаток)
- Клик → развернуть счета + платежи
- Кнопка "Новый счёт" → modal

**Действия:**
- Клик на платёж → если tochka_transaction_id, чек из Точки
- "+ Новый счёт" → modal (контрагент, сумма, описание, дата)

---

### Экран: Transactions — ИЗМЕНЕНИЕ
**Путь:** `/reports/transactions`

**Изменения:**
- Добавить столбец "Категория" (pnl_category)
- Фильтр по сотруднику (dropdown из employees таблицы)
- Клик на операцию → modal с кнопкой "Переместить в другую категорию"

---

### Экран: AI Commands — НОВЫЙ
**Путь:** `/ai-commands`

**Компоненты:**
- Текстовое поле для команды ("Счёт на Гайнетдинову 25K")
- Кнопка "Отправить"
- История команд (статус: pending, executed, failed)
- Карточка результата (с кнопками Approve/Reject)

**Действия:**
- Ввод команды → обработка < 3 сек
- Approve → выполнение (создание счёта, платёжки, переклассификация)
- Reject → отмена

---

### Экран: P&L — ИЗМЕНЕНИЕ
**Путь:** `/dashboard/p-l`

**Изменения:**
- Добавить "в пути" под доходом и расходом
- Расчёт: брутто (с в пути) и нетто (без в пути)
- Налог считается по нетто

---

## 5. БЛОК 5: Business Logic (АРХИТЕКТУРА И ПРАВИЛА)

### Категоризация и переклассификация

**На добавлении операции:**
1. Система смотрит на `description` (текст от Точки, Prodamus, ручной ввод)
2. Ищет в `category_rules` совпадения по keyword
3. Если есть правило (confidence > 0.7) → присваивает `pnl_category`
4. Если нет → либо показывает варианты, либо ставит "Прочее"

**При переклассификации (пользователь переместил):**
1. Пользователь кликает "Переместить" → выбирает новую категорию
2. Система обновляет `pnl_category` в transactions
3. Добавляет правило в `category_rules` (если его нет)
   - keyword = описание операции (первые 10 слов)
   - target_pnl_category = новая категория
   - confidence = 0.8
4. **AI учится:** в следующий раз похожие операции будут в новой категории

**Интеграция с существующим `transactionClassifier`:**
- Существующий классификатор ищет payroll_payees (Сунчелеева) и карты (Наташа)
- Новый модуль добавляет `category_rules` как дополнительный слой
- Приоритет: payroll_payees (ФОТ) → category_rules → default (Прочее)

---

### ФОТ (зарплаты)

**Основной ФОТ:**
- Сунчелеева Анастасия (по имени, как сейчас в `PAYROLL_PAYEES`)
- Транзакции НЕ хранят employee_id сами; employee_id добавляется по совпадению имени

**Операции по сотруднику:**
- Когда добавляем операцию с pnl_category="fot" и связываем её с employee_id, считаем её как "выплачено этому сотруднику"

**Остаток по сотруднику:**
- Остаток = salary_monthly - (sum всех выплат за месяц по этому сотруднику)

---

### Контрагенты и счета

**Только для ООО** (company_id='ooo')

**Статусы счётов:**
- draft: создан, не отправлен
- sent: отправлен контрагенту
- paid: получена оплата (дата_paid заполнена)
- cancelled: отменён

**Остаток задолженности:**
```
Остаток = (sum всех счётов по контрагенту, статус != cancelled) 
         - (sum всех платежей contractor_id)
```

---

### Деньги в пути

**Логика статусов:**
- `completed`: есть в выписке Точки (статус финальный)
- `pending`: операция ожидает (Prodamus in_transit, Точка ещё не синкнула)
- `returned`: возврат

**P&L расчёты:**
```
Доход:
  total = sum(income, любой статус)
  in_transit = sum(income, status=pending)
  real_income = total - in_transit

Расходы: аналогично

Налог считается по: (real_income - real_commission) × 8% (для ИП)
```

**Синк Точки (каждые 30 мин):**
- Новые операции → status='completed' (были в выписке)
- Старые pending операции → либо updated (если дошли), либо остаются pending

---

### Авто-УСН (налоги)

**Формула налога (для ИП на Авто-УСН):**
```
Доход = sum(all income, real, не в пути)
Комиссии = sum(all commission from Prodamus, real)
Налогооблагаемая база = Доход - Комиссии
Налог = Налогооблагаемая база × 8% (или другой %, уточнить)

Деньги в пути НЕ считаются в налог
```

**Платёжное поручение (AI-команда):**
- AI считает налог по формуле выше
- Генерирует PDF платёжка (реквизиты, сумма, дата платежа)
- Статус: draft (пользователь может одобрить и загрузить в Точку)

---

### Интеграции (как сейчас)

**Точка (авто-синк 2×/день):**
- Операции → transactions с tochka_transaction_id
- Статус = completed (если дошли в выписку)
- Классификация по `transactionClassifier`
- Курсы валют обновляются в начале синка

**Prodamus (webhook):**
- Маршрут: ДПО → ООО/prodamus_course, клуб → ИП/prodamus_club
- status = pending (пока деньги не дошли в Точку)
- Точка пропускает банковские зачисления от Prodamus (не двойной счёт)

**Lava.top (webhook):**
- OFFER_MAP: курсы ДПО → ООО, остальное → ИП
- HMAC signature валидация

---

## 6. БЛОК 6: Edge Cases (НОВЫЕ)

| # | Ситуация | Действие |
|---|----------|----------|
| 1 | Сотрудник добавлен без зарплаты (salary_monthly = NULL) | Alert: "установите зарплату перед расчётом". Остаток не считается |
| 2 | Операция на 5K, но выбран сотрудник с зарплатой 100K/мес | Нет проверки; система не валидирует адекватность. Бухгалтер проверяет |
| 3 | Переклассификация: старое правило конфликтует с новым | Новое правило > старое (overwrite в DB). Confidence сбрасывается в 0.8 |
| 4 | AI-команда неполная ("создай счёт" без суммы) | AI спрашивает: "на кого и на какую сумму?" Не создаёт без уточнения |
| 5 | Попытка создать счёт для ИП (ИП не выставляет счета) | 403: "Счета доступны только для ООО" |
| 6 | Две операции с одинаковой датой, суммой и описанием | Система не удаляет дубль автоматически; бухгалтер вручную проверяет |
| 7 | Контрагент платит частично (счёт 100K, платёж 70K, затем 30K) | Система суммирует все платежи. Остаток = 0 после второго платежа. OK |
| 8 | Платёжка сгенерирована, но юзер отклонил (rejected status) | Команда → ai_commands.status='rejected'. Платёжка не создаётся |
| 9 | В пути: операция pending 7 дней (не пришла) | Система показывает "in_transit". Бухгалтер может вручную отметить как "возврат" |
| 10 | Налог считается > 50% от дохода (явная ошибка) | Alert: "налог странно высокий, проверь расчёт". Система не блокирует |
| 11 | Займы (Фреш Кредит) в доходе; бухгалтер говорит исключить | РЕШЕНИЕ ОТЛОЖЕНО. Пока считаются как доход. Нужно правило от бухгалтера |
| 12 | Разнесение расходов по юрлицам: ДПО-расходы куда? | РЕШЕНИЕ ОТЛОЖЕНО. Нужно правило от бухгалтера (ООО или ИП?) |

---

## 7. Открытые вопросы (из SESSION_HANDOFF)

1. **Займы (Фреш Кредит):** считать ли доходом? → УТОЧНИТЬ
2. **Разнесение расходов по юрлицам:** какие расходы → ООО? → УТОЧНИТЬ
3. **Ежедневный отчёт ботом:** нужен ли? Время? Формат? → УТОЧНИТЬ
4. **Фонды:** подтвердить названия (Налоги ООО, р/с ИП коммунизм?) → УТОЧНИТЬ
5. **Карта Наташи (ip_acc2):** показывать ли в UI? → УТОЧНИТЬ

---

## 8. Гайдлайны разработки

**Архитектура:**
- Все новые эндпоинты → `src/server/index.ts → buildRouter()`
- Никаких новых файлов в `/api`
- Строго последовательные DB запросы (no Promise.all)
- Деньги только через `utils/money.ts` (копейки)

**Типизация:**
- TypeScript strict mode
- После изменений: `npx tsc --noEmit`

**Deployment:**
- push → Vercel автоматически задеплоит
- Secrets НЕ в репо (через Vercel UI)

**Тестирование:**
- Первые реальные платежи (Lava, Prodamus) → сверить подписи/формат

---

**SPEC готова для Claude Code.** ✅

