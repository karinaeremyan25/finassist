# 4-26 | API Debug Checklist — Отладка API-интеграций

> **Тип:** Reference / Checklist
> **Когда использовать:** Когда API-интеграция не работает и нужно быстро найти причину
> **Формат:** 6 шагов + таблица частых багов + curl-шаблоны

---

## Философия этого документа

Этот файл — **проверочный список после действия Claude или вашего**. Вы не идёте по нему вручную с нуля — вы используете его как:

1. **Чек-лист валидации** — когда Claude написал интеграцию, а она не работает, пробежаться по 6 шагам и найти где сломалось
2. **Reference для Claude** — загрузить в проект, чтобы Claude сам следовал этим правилам при отладке
3. **Quick-reference** — быстро найти нужный curl-шаблон или типичный баг по таблице

**Принцип работы:**
- Вы — архитектор: знаете, что интеграция должна работать определённым образом
- Claude Code — исполнитель: знает, как пройти по чек-листу и починить
- Этот документ — общий язык между вами

**Как применять:**
```
Сценарий 1: Claude отлаживает сам
  Вы → "API возвращает 401, пройди по debug checklist" → Claude следует 6 шагам

Сценарий 2: Вы отлаживаете сами
  Вы → открываете файл → идёте по шагам → находите причину

Сценарий 3: Совместно
  Claude → сделал интеграцию → Вы → сверяете результат с шагом 4 (field mapping) → указываете Claude на ошибку
```

---

## Правило номер один

**Никогда не позволяй Claude угадывать структуру API-ответа.** Всегда предоставляй реальный curl-ответ. 16-18 из 35 типичных багов в коде — ошибки интеграции API.

---

## 6 шагов отладки API

### Шаг 1: Идентификация запроса

Определи точно, какой запрос проваливается:

```bash
# Найди вызов в коде
grep -rn "fetch\|axios\|\.from\|\.rpc" src/lib/ src/app/actions/ --include="*.ts"

# Определи:
# - Метод (GET/POST/PUT/DELETE)
# - Полный URL (baseUrl + path)
# - Заголовки (Authorization, Content-Type)
# - Тело запроса (если POST/PUT)
```

**Что записать:**
| Параметр | Значение |
|----------|----------|
| Метод | GET / POST / PUT / DELETE |
| URL | https://... |
| Auth | Bearer / API Key / Basic |
| Content-Type | application/json |
| Body | {...} или нет |
| Ожидаемый статус | 200 / 201 |
| Фактический статус | 401 / 404 / 500 / timeout |

---

### Шаг 2: Raw curl тест

Воспроизведи запрос через curl ВРУЧНУЮ, вне приложения:

```bash
# GET-запрос
curl -v -X GET "https://api.timetracker.io/v2/entries?date=2026-04-10" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Accept: application/json"

# POST-запрос
curl -v -X POST "https://api.timetracker.io/v2/entries" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"project_name": "Test", "started_at": "2026-04-10T09:00:00Z"}'
```

**Флаг -v** показывает заголовки — это критически важно для отладки.

**Результат:**
- curl работает → проблема в коде (шаги 3-6)
- curl не работает → проблема в API/auth/URL (исправь сначала curl)

---

### Шаг 3: Сравнение схемы

Сравни РЕАЛЬНЫЙ ответ API с TypeScript-интерфейсом в коде:

```bash
# 1. Сохрани ответ curl в файл
curl -s "https://api.timetracker.io/v2/entries" \
  -H "Authorization: Bearer TOKEN" > /tmp/api_response.json

# 2. Посмотри структуру
cat /tmp/api_response.json | python3 -m json.tool

# 3. Найди интерфейс в коде
grep -rn "interface.*Response\|interface.*Entry\|type.*Response" src/types/ --include="*.ts"
```

**Что проверять:**
- Все ли поля из JSON есть в интерфейсе?
- Совпадает ли регистр? (`first_name` vs `firstName`)
- Совпадают ли типы? (string vs number, array vs object)
- Есть ли nullable поля? (`ended_at: null`)
- Вложенность правильная? (`data.entries` vs `data.items`)

---

### Шаг 4: Проверка URL-пути

**Самая частая ошибка — дублирование пути:**

```bash
# Найди baseUrl в коде
grep -rn "BASE_URL\|baseUrl\|apiUrl" src/lib/ --include="*.ts"

# Найди endpoint
grep -rn "fetch\|axios" src/lib/ --include="*.ts" -A 2
```

**Типичный баг:**
```typescript
// baseUrl = "https://api.timetracker.io/v2"
// endpoint = "/v2/entries"
// Результат: https://api.timetracker.io/v2/v2/entries → 404!

// ПРАВИЛЬНО:
// endpoint = "/entries"
// Результат: https://api.timetracker.io/v2/entries → 200
```

**Быстрая проверка:**
```bash
# Поиск дублирования путей
grep -rn "/v1.*v1\|/v2.*v2\|/api.*api" src/ --include="*.ts"
```

---

### Шаг 5: Верификация auth-токена

```bash
# 1. Проверь что env-переменная существует
echo $TIMETRACKER_API_KEY | wc -c  # длина токена

# 2. Проверь в коде
grep -rn "TIMETRACKER_API_KEY\|API_KEY\|API_TOKEN" src/ --include="*.ts"
grep -rn "TIMETRACKER_API_KEY\|API_KEY\|API_TOKEN" .env.local

# 3. Проверь формат заголовка
# Правильно: "Authorization: Bearer sk_abc123..."
# Неправильно: "Authorization: sk_abc123..." (без Bearer)
# Неправильно: "Authorization: Bearer Bearer sk_abc123..." (двойной Bearer)
```

**Частые проблемы с токенами:**

| Проблема | Симптом | Как найти |
|----------|---------|-----------|
| Токен не в .env.local | `undefined` в запросе | Проверь файл .env.local |
| Пробел в конце токена | 401 Unauthorized | `echo -n "$TOKEN" \| xxd \| tail -1` |
| Токен обрезан кавычками | 401 Unauthorized | Убери кавычки из .env.local |
| Нет prefix (Bearer/Basic) | 401 Unauthorized | Проверь документацию API |
| NEXT_PUBLIC_ prefix | Токен виден клиенту | Убери NEXT_PUBLIC_ |

---

### Шаг 6: Edge cases

Проверь граничные ситуации:

```bash
# Пустой ответ
curl -s "https://api.timetracker.io/v2/entries?date=2020-01-01" \
  -H "Authorization: Bearer TOKEN"
# Ожидание: пустой массив entries, не ошибка

# Большой ответ (пагинация)
curl -s "https://api.timetracker.io/v2/entries?per_page=1" \
  -H "Authorization: Bearer TOKEN"
# Ожидание: meta.total_entries > meta.per_page

# Невалидные параметры
curl -s "https://api.timetracker.io/v2/entries?date=invalid" \
  -H "Authorization: Bearer TOKEN"
# Ожидание: 400 Bad Request с описанием ошибки

# Истёкший токен
curl -s "https://api.timetracker.io/v2/entries" \
  -H "Authorization: Bearer expired_token"
# Ожидание: 401 Unauthorized
```

---

## Таблица частых багов API-интеграций

| # | Баг | Симптом | Причина | Исправление |
|---|-----|---------|---------|-------------|
| 1 | Дублирование пути | 404 Not Found | baseUrl + "/v2/entries" = "/v2/v2/entries" | Убери версию из endpoint |
| 2 | snake_case vs camelCase | `undefined` при доступе к полю | API: `first_name`, код: `firstName` | Маппинг или интерфейс по реальному ответу |
| 3 | parseInt на строковом ID | Некорректный ID, `NaN` | `parseInt("ent_8f3k2")` = `NaN` | Используй `String()` для всех ID |
| 4 | Токен обрезан | 401 Unauthorized | Пробел/кавычки в .env.local | Проверь длину: `token?.length` |
| 5 | Нет обработки null | Runtime crash | API вернул `null`, код ожидает значение | Добавь `\| null` в интерфейс |
| 6 | Нет пагинации | Часть данных не загружена | API вернул page 1 из 5 | Цикл по meta.total vs loaded |
| 7 | Таймаут | Зависание запроса | API медленный, нет timeout | `AbortSignal.timeout(10000)` |
| 8 | JSON parse error | Crash при разборе | API вернул HTML (ошибка прокси) | Проверь Content-Type ответа |
| 9 | CORS на клиенте | Ошибка в браузере | Запрос к API из клиента | Перенеси в Server Action |
| 10 | Двойной Bearer | 401 Unauthorized | `Bearer Bearer token` | Проверь шаблон Authorization |

---

## Curl-шаблоны для копирования

### GET с авторизацией
```bash
curl -v -X GET "URL" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Accept: application/json"
```

### POST с JSON body
```bash
curl -v -X POST "URL" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "field1": "value1",
    "field2": 123
  }'
```

### PUT обновление
```bash
curl -v -X PUT "URL/resource_id" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "field1": "updated_value"
  }'
```

### DELETE
```bash
curl -v -X DELETE "URL/resource_id" \
  -H "Authorization: Bearer $API_TOKEN"
```

### С таймаутом и повторной попыткой
```bash
curl -v --max-time 10 --retry 3 --retry-delay 2 \
  -X GET "URL" \
  -H "Authorization: Bearer $API_TOKEN"
```

### Сохранить ответ + заголовки
```bash
curl -s -D /tmp/headers.txt -o /tmp/response.json \
  -X GET "URL" \
  -H "Authorization: Bearer $API_TOKEN"

echo "=== HEADERS ==="
cat /tmp/headers.txt
echo "=== BODY ==="
cat /tmp/response.json | python3 -m json.tool
```

### Проверка только статуса
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X GET "URL" \
  -H "Authorization: Bearer $API_TOKEN"
```

---

## Алгоритм в виде дерева решений

```
API не работает
  │
  ├─ curl тоже не работает?
  │   ├─ 401 → Проблема с токеном (Шаг 5)
  │   ├─ 404 → Неправильный URL (Шаг 4)
  │   ├─ 403 → Нет прав / IP заблокирован
  │   ├─ 500 → Проблема на стороне API (подожди / обратись в поддержку)
  │   └─ timeout → API недоступен или медленный
  │
  └─ curl работает, код — нет?
      ├─ Данные не маппятся → Сравни схему (Шаг 3)
      ├─ URL отличается от curl → Проверь путь (Шаг 4)
      ├─ Ошибка CORS → Перенеси в Server Action
      └─ Runtime error → Проверь null/undefined поля (Шаг 6)
```

---

*Нашёл проблему? Используй [4-24 Bug Fix Prompt](4-24-BUG_FIX_PROMPT.md) для системного исправления.*
