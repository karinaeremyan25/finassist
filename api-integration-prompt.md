# 4-25 | API Integration Prompt — Интеграция внешних API

> **Тип:** Instruction
> **Когда использовать:** Когда нужно подключить внешний API к проекту
> **Результат:** Работающая интеграция с правильными типами, обработкой ошибок и edge cases

---

## Философия этого документа

Этот файл — **готовый промпт для Claude Code**. Вы не пишете его сами — копируете и используете.

**Принцип работы:**
- Вы — архитектор и коммуникатор
- Claude Code — исполнитель: читает промпт, делает работу
- Ваша задача — собрать реальные curl-ответы API и скопировать правильный промпт

**Workflow:**
```
Вы → копируете промпт → вставляете в Claude Code (VS Code)
       ↓
       прикрепляете свой контекст (docs API + реальные curl-ответы)
       ↓
Claude Code → строит интеграцию по точной схеме ответа
       ↓
Вы → тестируете на реальных данных → принимаете
```

Промпт уже отлажен. Не нужно его улучшать с первого раза — просто используйте.

---

## Что это такое

Промпт для интеграции внешнего API, основанный на главном правиле: **никогда не позволяй Claude угадывать структуру ответа API**. Ты ВСЕГДА предоставляешь реальный curl-ответ — Claude строит интеграцию по ТОЧНОЙ схеме.

**Статистика:** 16-18 из 35 типичных багов в коде — ошибки интеграции API. Этот промпт предотвращает 90% из них.

---

## Workflow интеграции

```
1. Получи API-документацию или доступ
2. Сделай реальный curl-запрос
3. Скопируй ответ в промпт
4. Claude создаёт типы по РЕАЛЬНОМУ ответу
5. Claude строит интеграцию
6. Проверяешь: пути, маппинг полей, auth
```

---

## Промпт для копирования

```
Мне нужно интегрировать [название API] в проект.

## Реальный ответ API

Я сделал curl-запрос:
```bash
curl -X GET "https://api.example.com/v1/endpoint" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json"
```

Ответ:
```json
[ВСТАВЬ РЕАЛЬНЫЙ JSON-ОТВЕТ СЮДА]
```

## Что нужно сделать

1. Создай TypeScript-интерфейс, точно соответствующий этому JSON-ответу
2. Создай серверную функцию для вызова API
3. Обработай ошибки: таймаут, 401, 403, 404, 500, невалидный JSON
4. Создай Server Action для использования из UI

## Обязательные проверки

- URL: убедись что нет дублирования пути (если baseUrl = "https://api.example.com/v1", не добавляй /v1 снова)
- Поля: маппинг точно по JSON — snake_case vs camelCase
- Auth: токен из env, полная длина (не обрезан)
- Типы: никаких any — точные типы по ответу

## Куда положить файлы
- Типы: src/types/[api-name].ts
- API-клиент: src/lib/[api-name]/client.ts
- Server Action: src/app/actions/[api-name].ts
```

---

## Пример: Интеграция TimeTracker API в TaskFlow

### Шаг 1: curl-запрос

```bash
curl -X GET "https://api.timetracker.io/v2/entries?date=2026-04-10" \
  -H "Authorization: Bearer tt_key_abc123example" \
  -H "Accept: application/json"
```

### Шаг 2: Реальный ответ

```json
{
  "status": "ok",
  "data": {
    "entries": [
      {
        "entry_id": "ent_8f3k2",
        "project_name": "TaskFlow MVP",
        "task_description": "Реализация дашборда",
        "started_at": "2026-04-10T09:00:00Z",
        "ended_at": "2026-04-10T11:30:00Z",
        "duration_minutes": 150,
        "billable": true,
        "hourly_rate_cents": 5000,
        "tags": ["development", "frontend"]
      },
      {
        "entry_id": "ent_9g4l3",
        "project_name": "TaskFlow MVP",
        "task_description": "Фикс багов в формах",
        "started_at": "2026-04-10T13:00:00Z",
        "ended_at": null,
        "duration_minutes": null,
        "billable": true,
        "hourly_rate_cents": 5000,
        "tags": ["bugfix"]
      }
    ],
    "total_minutes": 150,
    "total_billable_cents": 12500
  },
  "meta": {
    "page": 1,
    "per_page": 50,
    "total_entries": 2
  }
}
```

### Шаг 3: Промпт для Claude Code

```
Интегрируй TimeTracker API в TaskFlow для импорта записей о времени.

## Реальный ответ API

curl -X GET "https://api.timetracker.io/v2/entries?date=2026-04-10" \
  -H "Authorization: Bearer tt_key_abc123example"

Ответ:
{
  "status": "ok",
  "data": {
    "entries": [
      {
        "entry_id": "ent_8f3k2",
        "project_name": "TaskFlow MVP",
        "task_description": "Реализация дашборда",
        "started_at": "2026-04-10T09:00:00Z",
        "ended_at": "2026-04-10T11:30:00Z",
        "duration_minutes": 150,
        "billable": true,
        "hourly_rate_cents": 5000,
        "tags": ["development", "frontend"]
      }
    ],
    "total_minutes": 150,
    "total_billable_cents": 12500
  },
  "meta": {
    "page": 1,
    "per_page": 50,
    "total_entries": 2
  }
}

## Требования

1. TypeScript-интерфейс по ЭТОМУ JSON
2. API-клиент с обработкой ошибок
3. Server Action для импорта записей за указанную дату
4. Маппинг entry → запись в таблицу time_entries в Supabase
5. Пагинация: если total_entries > per_page — загрузить все страницы

## Проверь

- baseUrl = "https://api.timetracker.io/v2" → endpoint = "/entries" (не "/v2/entries")
- entry_id — строка, не число (не парси parseInt)
- ended_at может быть null (запись ещё идёт)
- duration_minutes может быть null
- hourly_rate_cents — центы, не рубли (делить на 100 при отображении)
```

### Шаг 4: Ожидаемый результат

**src/types/timetracker.ts**
```typescript
export interface TimeTrackerEntry {
  entry_id: string
  project_name: string
  task_description: string
  started_at: string
  ended_at: string | null
  duration_minutes: number | null
  billable: boolean
  hourly_rate_cents: number
  tags: string[]
}

export interface TimeTrackerResponse {
  status: 'ok' | 'error'
  data: {
    entries: TimeTrackerEntry[]
    total_minutes: number
    total_billable_cents: number
  }
  meta: {
    page: number
    per_page: number
    total_entries: number
  }
}

export interface TimeTrackerError {
  status: 'error'
  message: string
  code: string
}
```

**src/lib/timetracker/client.ts**
```typescript
const BASE_URL = 'https://api.timetracker.io/v2'

export async function fetchTimeEntries(
  date: string,
  page: number = 1
): Promise<TimeTrackerResponse> {
  const token = process.env.TIMETRACKER_API_KEY
  if (!token) {
    throw new Error('TIMETRACKER_API_KEY не настроен в .env.local')
  }

  const url = `${BASE_URL}/entries?date=${date}&page=${page}`

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    next: { revalidate: 0 }, // не кэшировать
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `TimeTracker API ошибка ${response.status}: ${errorBody}`
    )
  }

  const data: TimeTrackerResponse = await response.json()

  if (data.status !== 'ok') {
    throw new Error(`TimeTracker вернул ошибку: ${JSON.stringify(data)}`)
  }

  return data
}

export async function fetchAllTimeEntries(
  date: string
): Promise<TimeTrackerEntry[]> {
  const allEntries: TimeTrackerEntry[] = []
  let page = 1

  while (true) {
    const response = await fetchTimeEntries(date, page)
    allEntries.push(...response.data.entries)

    if (allEntries.length >= response.meta.total_entries) break
    page++

    if (page > 100) break // защита от бесконечного цикла
  }

  return allEntries
}
```

**src/app/actions/timetracker.ts**
```typescript
'use server'

import { createClient } from '@/lib/supabase/server'
import { fetchAllTimeEntries } from '@/lib/timetracker/client'
import { revalidatePath } from 'next/cache'

export async function importTimeEntries(date: string) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return { success: false, error: 'Необходимо авторизоваться' }
    }

    const entries = await fetchAllTimeEntries(date)

    // Маппинг TimeTracker → Supabase
    const dbEntries = entries.map(entry => ({
      external_id: entry.entry_id,
      project_name: entry.project_name,
      description: entry.task_description,
      started_at: entry.started_at,
      ended_at: entry.ended_at,
      duration_minutes: entry.duration_minutes,
      is_billable: entry.billable,
      rate_cents: entry.hourly_rate_cents,
      tags: entry.tags,
      user_id: user.id,
    }))

    // Upsert по external_id (не создавать дубликаты)
    const { error } = await supabase
      .from('time_entries')
      .upsert(dbEntries, { onConflict: 'external_id' })

    if (error) {
      return { success: false, error: error.message }
    }

    revalidatePath('/time')
    return {
      success: true,
      data: { imported: entries.length }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Неизвестная ошибка'
    return { success: false, error: message }
  }
}
```

---

## Чеклист перед отправкой промпта

- [ ] Сделал реальный curl-запрос (не из документации, а реальный ответ)
- [ ] Указал baseUrl и endpoint отдельно (чтобы Claude не дублировал пути)
- [ ] Указал формат ID (string vs number), дат, денег, nullable полей
- [ ] Добавил API KEY в .env.local.example

---

## Типичные ошибки интеграции

| Ошибка | Симптом | Решение |
|--------|---------|---------|
| Дублирование пути (/v2/v2/) | 404 | Разделяй baseUrl и endpoint |
| snake_case vs camelCase | undefined | Интерфейс по РЕАЛЬНОМУ ответу |
| parseInt на строковом ID | NaN | Всегда String для ID |
| Токен обрезан | 401 | Логируй длину токена |
| Нет пагинации | Часть данных пропущена | Проверяй meta.total vs loaded |
| Null не обработан | Runtime crash | Nullable в интерфейсе |

---

*Интеграция готова? Запусти [4-23 Security Review](4-23-SECURITY_REVIEW_PROMPT.md) чтобы проверить что API-ключи не утекли.*
