# feature-spec-pnl.md — P&L отчёт, личные траты, автоматизация расходов

> **Дата:** 2026-06-13
> **Статус:** Спека готова, разработка не начата
> **Уровень:** Фича — новый экран `/pnl` + карточка на Dashboard + новые API-эндпоинты
> **Зависимости:** `mini-app.architector.md` (платформа, синхронизация Точки), `feature-spec-integrations-sync.md` (webhook Prodamus/Robokassa)

---

## Суть фичи

Добавляем в Mini App:

1. **Экран P&L** `/pnl` — ежемесячный и годовой отчёт о прибылях и убытках по двум юрлицам (ИП + ООО) со сводным итогом.
2. **Карточка личных трат** на главном Dashboard — прогресс-бары по категориям с % и сравнением с прошлым месяцем.
3. **График динамики** — пять линий: доходы, расходы, прибыль, ФОТ, кредиты.
4. **AI-классификация расходов** из выписки Точки — автоматическая категоризация всех списаний.
5. **Выгрузка Excel** — один файл, три листа: ИП / ООО / Сводный.

**Ручного ввода не остаётся.** Бухгалтер только проверяет и при необходимости исправляет категорию транзакции.

---

## Источники данных

| Статья | Откуда | Механизм |
|--------|--------|----------|
| Доходы РФ (курсы, клуб) | Prodamus, Robokassa | Webhook → `transactions` |
| Доходы на счёт | Точка (расчётный счёт) | Pull выписки каждые 30 мин → `transactions` |
| ФОТ | Точка (переводы физлицам) | Pull + AI-классификация → категория `payroll` |
| Маркетинг | Точка (переводы ИП по договору) | Pull + AI-классификация → категория `marketing` |
| Кредиты | Точка (регулярные платежи) | Pull + AI-классификация → категория `loan` |
| Подписки/сервисы | Точка | Pull + AI-классификация → категория `subscriptions` |
| Личные траты | Точка (Wildberries, АЗС, Пятёрочка и т.д.) | Pull + AI-классификация → категория `personal_*` |
| Налог | — | Расчёт: `income * 0.08` за месяц, не хранится отдельно |
| Прибыль бизнеса | — | Расчёт: `income − expenses_business`, не хранится |

---

## Категории транзакций

### Бизнес-расходы
| Код | Название | Примеры контрагентов |
|-----|----------|---------------------|
| `payroll` | ФОТ | Переводы физлицам с назначением «зарплата», «аванс» |
| `marketing` | Маркетинг / реклама | Переводы ИП по договору на рекламу |
| `loan` | Кредиты | Банк, МФО, регулярные платежи с одинаковой суммой |
| `subscriptions` | Подписки и сервисы | Хостинг, SaaS, инструменты |
| `tax` | Налог | Расчётный (8% от выручки), не из выписки |
| `payment_commission` | Комиссии платёжек | Автоматом из данных Prodamus/Robokassa |
| `other_business` | Прочие бизнес | Не попало в категорию выше |

### Личные расходы собственника
| Код | Название в карточке | Примеры |
|-----|--------------------|---------| 
| `personal_food` | Еда и продукты | Пятёрочка, Магнит, ВкусВилл, Перекрёсток |
| `personal_shopping` | Онлайн-шопинг | Wildberries, Ozon, AliExpress |
| `personal_fuel` | Бензин | АЗС Лукойл, Газпромнефть, Shell |
| `personal_restaurant` | Рестораны | Кафе, рестораны, доставка еды |
| `personal_entertainment` | Развлечения | Кино, концерты, спорт |
| `personal_coffee` | Кофе | Кофейни, Starbucks, Шоколадница |
| `personal_other` | Прочее личное | Аптека, одежда, не классифицировано |

**Принцип:** личные расходы не влияют на прибыль бизнеса. Они учитываются отдельно как «распределение прибыли собственником».

---

## AI-классификатор транзакций

### Где живёт
`src/services/transactionClassifier.ts` — использует `claude-sonnet-4-6` (`config.CLAUDE_MODEL`), температура 0.1 (детерминированный режим).

### Вызов
Классификатор вызывается внутри `src/services/integrations/tochka.ts` при записи каждой новой транзакции из выписки.

### Промпт-логика
```
Входные данные одной транзакции:
- counterparty: название контрагента из выписки
- amount: сумма (отрицательная = расход)
- description: назначение платежа
- inn: ИНН контрагента (если есть)

Задача: вернуть JSON { category: string, confidence: number, is_personal: boolean }

Категории бизнес: payroll | marketing | loan | subscriptions | other_business | income
Категории личные: personal_food | personal_shopping | personal_fuel | personal_restaurant | personal_entertainment | personal_coffee | personal_other

Правила:
- Если сумма положительная → income (не классифицировать дальше)
- Переводы физлицам с назначением «зарплата/аванс» → payroll
- Переводы ИП с назначением «по договору №... реклама/маркетинг» → marketing
- Wildberries, Ozon, AliExpress → personal_shopping
- АЗС любые → personal_fuel
- Пятёрочка, Магнит, ВкусВилл, Перекрёсток, Лента → personal_food
- Если confidence < 0.7 → категория other_business или personal_other, флаг needs_review: true
```

### Поле `needs_review`
Если классификатор не уверен (confidence < 0.7) — транзакция получает флаг `needs_review = true`. Бухгалтер видит такие транзакции в отдельном фильтре на экране Transactions и может исправить категорию одним тапом.

---

## Изменения в БД

### Новые поля в таблице `transactions`

```sql
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS
  category TEXT DEFAULT 'other_business';

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS
  is_personal BOOLEAN DEFAULT false;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS
  classifier_confidence NUMERIC(3,2);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS
  needs_review BOOLEAN DEFAULT false;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS
  category_overridden_by UUID REFERENCES app_users(id);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS
  category_overridden_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_is_personal ON transactions(is_personal);
CREATE INDEX IF NOT EXISTS idx_transactions_needs_review ON transactions(needs_review) WHERE needs_review = true;
```

### Миграция
Файл: `migrations/006_pnl_classification.sql`

---

## Новые API-эндпоинты

Все эндпоинты добавляются в `src/server/routes/analytics.ts`. Авторизация — стандартная Telegram initData (как у существующих эндпоинтов).

---

### `GET /api/analytics/pnl`

P&L за период по юрлицу.

**Query params:**
```
entity: 'ip' | 'ooo' | 'total'   // юрлицо или сводный
period: 'YYYY-MM'                 // месяц, например 2026-05
```

**Ответ 200:**
```json
{
  "entity": "ip",
  "period": "2026-05",
  "income": {
    "total": 124000000,
    "sources": {
      "prodamus": 89000000,
      "robokassa": 21000000,
      "tochka_direct": 14000000
    }
  },
  "expenses": {
    "total": 55250000,
    "breakdown": {
      "payroll": 28000000,
      "marketing": 12000000,
      "tax": 9920000,
      "payment_commission": 3720000,
      "subscriptions": 1610000,
      "loan": 0,
      "other_business": 0
    }
  },
  "profit": 68750000,
  "margin_pct": 55.4,
  "vs_prev_month": {
    "income_delta_pct": 9.9,
    "profit_delta_pct": 12.3
  }
}
```

**Ответ 400:**
```json
{ "error": { "code": "INVALID_PARAMS", "message": "entity must be ip | ooo | total" } }
```

---

### `GET /api/analytics/pnl/year`

Годовой P&L помесячно.

**Query params:**
```
entity: 'ip' | 'ooo' | 'total'
year: number   // например 2026
```

**Ответ 200:**
```json
{
  "entity": "total",
  "year": 2026,
  "months": [
    {
      "month": "2026-01",
      "income": 118000000,
      "expenses": 62000000,
      "profit": 56000000,
      "margin_pct": 47.5
    }
  ],
  "totals": {
    "income": 864000000,
    "expenses": 452000000,
    "profit": 412000000,
    "margin_pct": 47.7
  }
}
```

---

### `GET /api/analytics/personal-spending`

Личные траты собственника за период.

**Query params:**
```
period: 'YYYY-MM'
```

**Ответ 200:**
```json
{
  "period": "2026-05",
  "total": 8740000,
  "vs_prev_month_pct": 12.0,
  "categories": [
    {
      "code": "personal_food",
      "label": "Еда и продукты",
      "amount": 2840000,
      "pct": 32.5,
      "vs_prev_month_pct": 8.0
    },
    {
      "code": "personal_shopping",
      "label": "Онлайн-шопинг",
      "amount": 2100000,
      "pct": 24.0,
      "vs_prev_month_pct": 31.0
    },
    {
      "code": "personal_fuel",
      "label": "Бензин",
      "amount": 1480000,
      "pct": 16.9,
      "vs_prev_month_pct": -5.0
    },
    {
      "code": "personal_restaurant",
      "label": "Рестораны",
      "amount": 1220000,
      "pct": 14.0,
      "vs_prev_month_pct": -3.0
    },
    {
      "code": "personal_entertainment",
      "label": "Развлечения",
      "amount": 740000,
      "pct": 8.5,
      "vs_prev_month_pct": 0
    },
    {
      "code": "personal_coffee",
      "label": "Кофе",
      "amount": 360000,
      "pct": 4.1,
      "vs_prev_month_pct": 20.0
    }
  ]
}
```

---

### `PATCH /api/analytics/transactions/:id/category`

Ручное исправление категории бухгалтером.

**Body:**
```json
{ "category": "marketing" }
```

**Ответ 200:**
```json
{
  "id": "txn_abc123",
  "category": "marketing",
  "needs_review": false,
  "category_overridden_at": "2026-05-15T10:30:00Z"
}
```

**Ответ 400:**
```json
{ "error": { "code": "INVALID_CATEGORY", "message": "Unknown category: foo" } }
```

---

### `GET /api/analytics/pnl/export`

Выгрузка Excel. Возвращает бинарный файл.

**Query params:**
```
period: 'YYYY-MM'   // месяц
year: number        // если указан — годовой отчёт
```

**Response headers:**
```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="pnl-2026-05.xlsx"
```

**Структура файла:** три листа — `ИП`, `ООО`, `Сводный`. Каждый лист: строки по статьям (доходы, ФОТ, маркетинг, налог, комиссии, подписки, кредиты, прочее, прибыль, маржа %). Для годового — колонки по месяцам + итого.

**Библиотека:** `exceljs` (уже в зависимостях или добавить `npm install exceljs`).

---

## UI: экран `/pnl`

Новый экран в `src/app/webapp/src/pages/PnL.tsx`.

### Структура экрана

```
[Вкладки: ИП | ООО | Сводный | Год]

[Селектор периода: ← Май 2026 →]

[KPI-карточки 2×2]
  Выручка | Прибыль
  Расходы | Маржа %

[Блок: Доходы]
  Продамус / Робокасса / Точка напрямую

[Блок: Расходы бизнеса]
  ФОТ / Маркетинг / Налог (8%) / Комиссии / Подписки / Кредиты

[Итог: Чистая прибыль бизнеса]  ← зелёный

[Блок: Личные расходы собственника]
  Итого личных трат / % от прибыли
  (не влияет на прибыль бизнеса выше)

[Кнопка: Выгрузить Excel ↓]
```

### Состояния
- **Loading:** skeleton по всем блокам
- **Empty (нет данных за период):** «Нет транзакций за выбранный период» + стрелка к настройкам синхронизации
- **Error:** toast «Ошибка загрузки данных» + кнопка «Повторить»
- **needs_review > 0:** жёлтый баннер вверху «N транзакций требуют проверки категории» → ведёт на экран Transactions с фильтром `needs_review=true`

---

## UI: карточка личных трат на Dashboard

Добавляется в `src/app/webapp/src/pages/Dashboard.tsx` после существующих KPI-карточек.

### Дизайн (вариант А — прогресс-бары)

```
┌─────────────────────────────────────┐
│ Личные траты          87 400 ₽      │
│ Июнь · vs май         +12% к пред.  │
│                                     │
│ ● Еда и продукты   28 400 ₽  33%   │
│ ████████░░░░░░░░░░░░               │
│   ↑ +8% к маю                      │
│                                     │
│ ● Онлайн-шопинг    21 000 ₽  24%   │
│ ██████░░░░░░░░░░░░░               │
│   ↑ +31% к маю                     │
│                                     │
│ ... (все 6 категорий)               │
└─────────────────────────────────────┘
```

**Цвета категорий:**
- Еда: `#534AB7` (purple)
- Онлайн-шопинг: `#D85A30` (coral)
- Бензин: `#BA7517` (amber)
- Рестораны: `#1D9E75` (teal)
- Развлечения: `#378ADD` (blue)
- Кофе: `#888780` (gray)

**Стрелки изменений:**
- Рост → красный `↑ +N%` (тратишь больше)
- Снижение → зелёный `↓ −N%` (тратишь меньше)
- Без изменений → серый `→ без изменений`

**Тап на карточку** → переход на экран `/pnl` с открытой вкладкой личных трат.

---

## UI: график динамики

Добавляется на экран `/pnl` под таблицей (или как отдельная вкладка на Dashboard).

**Пять линий с разными штрихами:**
| Линия | Цвет | Штрих |
|-------|------|-------|
| Доходы | `#1D9E75` | сплошная |
| Расходы | `#E24B4A` | `[4,3]` |
| Прибыль | `#378ADD` | `[2,2]` |
| ФОТ | `#534AB7` | `[8,4]` |
| Кредиты | `#BA7517` | `[3,3]` |

**Период:** последние 12 месяцев (или с начала года если < 12 мес.).

---

## Навигация

Добавить пункт **«P&L»** в нижнее меню Mini App рядом с Dashboard / Transactions / Settings.

Иконка: `ti-chart-bar` (Tabler).

---

## Edge cases

| # | Ситуация | Поведение |
|---|----------|-----------|
| 1 | Транзакция из Точки — новый неизвестный контрагент | Классификатор ставит `other_business`, `needs_review = true`, баннер на P&L |
| 2 | Личная трата записана как бизнес-расход (ошибка классификации) | Бухгалтер меняет категорию через PATCH, пересчёт P&L мгновенный |
| 3 | Нет транзакций за выбранный месяц | Empty-состояние с подсказкой |
| 4 | Продамус/Robokassa webhook не пришёл | Доходы за период будут неполными; баннер «Последняя синхронизация: N часов назад» |
| 5 | Excel-файл генерируется > 3 сек | Лоадер на кнопке, скачивание по готовности |
| 6 | Налог 8% — период с нулевой выручкой | Налог = 0, без ошибок |
| 7 | ООО не имеет транзакций (только ИП) | Вкладка ООО показывает нули + Empty-баннер «Транзакций не найдено» |
| 8 | Одна транзакция = и доход и расход (возврат) | Обрабатывать по знаку суммы: + доход, − расход |
| 9 | Классификатор Claude недоступен | Транзакция записывается с `category = 'other_business'`, `needs_review = true`, retry через 5 мин |
| 10 | Личные траты > прибыли бизнеса | Показывать как есть, без предупреждения (это управленческий факт, не ошибка) |

---

## Файлы для создания / изменения

| Файл | Действие |
|------|----------|
| `migrations/006_pnl_classification.sql` | Создать — новые поля в `transactions` |
| `src/services/transactionClassifier.ts` | Создать — AI-классификатор |
| `src/services/integrations/tochka.ts` | Изменить — вызов классификатора после записи транзакции |
| `src/server/routes/analytics.ts` | Изменить — добавить 4 новых эндпоинта |
| `src/app/webapp/src/pages/PnL.tsx` | Создать — новый экран |
| `src/app/webapp/src/pages/Dashboard.tsx` | Изменить — карточка личных трат |
| `src/app/webapp/src/components/PersonalSpendCard.tsx` | Создать — компонент карточки (прогресс-бары) |
| `src/app/webapp/src/components/DynamicsChart.tsx` | Создать — график пяти линий |
| `src/app/webapp/src/components/BottomNav.tsx` | Изменить — добавить пункт P&L |

---

## Старт разработки этой фичи

```
Реализуем фичу P&L по спеке feature-spec-pnl.md.
Контекст проекта — в SESSION_HANDOFF.md.
Стек: Node.js/TypeScript бэкенд + React/Vite/Tailwind фронтенд.

Начнём с миграции 006_pnl_classification.sql,
затем transactionClassifier.ts,
затем новые эндпоинты в analytics.ts.
```
