import { z } from 'zod';
import { config } from '../config.js';
import { callClaude } from './claude.js';
import { listRules, matchRule } from '../db/repositories/categoryRules.js';
import { getActivePayrollPatterns } from '../db/repositories/employees.js';
import { childLogger } from '../utils/logger.js';

/**
 * Батч-классификатор расходных транзакций для P&L.
 *
 * Назначает каждой транзакции одну из категорий (бизнес или личную) + confidence.
 * Работает батчами (~20 транзакций на один вызов Claude), чтобы не делать
 * сотни одиночных запросов при первичной классификации выписки.
 *
 * Модель — config.CLAUDE_MODEL (НЕ хардкодим). Параметр temperature НЕ
 * передаётся: новые модели Anthropic отклоняют его (400).
 *
 * В лог попадают только метаданные (id транзакций, размер батча, категории),
 * НЕ полный текст транзакций (counterparty/description).
 */

const log = childLogger({ handler: 'transactionClassifier' });

const BATCH_SIZE = 20;
const MAX_TOKENS = 4096;
const CONFIDENCE_THRESHOLD = 0.7;

/** Бизнес-категории расходов. */
const BUSINESS_CATEGORIES = [
  'payroll',
  'marketing',
  'loan',
  'subscriptions',
  'tax',
  'other_business',
] as const;

/** Личные категории расходов. */
const PERSONAL_CATEGORIES = [
  'personal_food',
  'personal_shopping',
  'personal_fuel',
  'personal_restaurant',
  'personal_entertainment',
  'personal_coffee',
  'personal_other',
] as const;

const ALL_CATEGORIES = [
  ...BUSINESS_CATEGORIES,
  ...PERSONAL_CATEGORIES,
  'income',
] as const;

type Category = (typeof ALL_CATEGORIES)[number];

const PERSONAL_SET = new Set<string>(PERSONAL_CATEGORIES);

/**
 * Известные получатели зарплаты (ФОТ) — переводы им всегда payroll,
 * независимо от мнения модели. Дополнять по мере появления сотрудников.
 */
const PAYROLL_PAYEES = /сунчелеев|суншелеев/i;

export interface TxToClassify {
  id: string;
  counterparty: string | null;
  amount: number;
  description: string | null;
  inn: string | null;
  flowType: 'income' | 'expense';
}

export interface TxClassification {
  id: string;
  pnlCategory: string;
  confidence: number;
  isPersonal: boolean;
}

/** Схема одного элемента JSON-ответа Claude. */
const ClaudeItemSchema = z.object({
  id: z.string(),
  category: z.enum(ALL_CATEGORIES),
  confidence: z.number().min(0).max(1),
  is_personal: z.boolean(),
});

/**
 * Claude может вернуть либо «голый» массив, либо объект с полем-обёрткой
 * (например {"results":[...]}). callClaude(expectJson:true) гарантирует объект,
 * поэтому массив всегда приходит внутри объекта — берём первое массив-поле.
 */
const ClaudeResponseSchema = z
  .record(z.unknown())
  .transform((obj, ctx) => {
    const arr = Object.values(obj).find((v) => Array.isArray(v));
    if (arr === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'no array field in response' });
      return z.NEVER;
    }
    return arr;
  })
  .pipe(z.array(ClaudeItemSchema));

const SYSTEM_PROMPT = `Ты — классификатор финансовых РАСХОДНЫХ транзакций для системы учёта FinAssist.

Тебе на вход придёт JSON-массив транзакций. Для КАЖДОЙ транзакции верни одну категорию, число confidence (0..1) и флаг is_personal.

Категории бизнес-расходов:
- payroll — переводы физлицам с назначением «зарплата», «аванс», выплата сотруднику
- marketing — переводы ИП/компаниям с назначением «по договору ... реклама/маркетинг/таргет/SMM»
- loan — регулярные платежи банкам/МФО, погашение кредита, проценты
- subscriptions — хостинг, SaaS, облака, домены, онлайн-сервисы (подписки)
- tax — налоги, страховые взносы, ФНС, патент
- other_business — прочий бизнес-расход, не подходящий под категории выше

Личные категории (is_personal=true):
- personal_food — продуктовые магазины: Пятёрочка, Магнит, ВкусВилл, Перекрёсток, Лента, Ашан
- personal_shopping — онлайн-шопинг: Wildberries, Ozon, AliExpress, маркетплейсы
- personal_fuel — любые АЗС: Лукойл, Газпромнефть, Роснефть, Shell, Татнефть
- personal_restaurant — рестораны, кафе, доставка еды (Delivery, Самокат-готовое, Яндекс.Еда)
- personal_entertainment — кино, концерты, спорт, фитнес, развлечения
- personal_coffee — кофейни: Starbucks, Шоколадница, Cofix, Surf Coffee
- personal_other — прочее личное: аптека, одежда, неклассифицированное личное

Правила:
- Переводы физлицам «зарплата/аванс» → payroll.
- ИП по договору с упоминанием рекламы/маркетинга → marketing.
- Wildberries, Ozon, AliExpress → personal_shopping.
- Любые АЗС → personal_fuel.
- Пятёрочка, Магнит, ВкусВилл, Перекрёсток, Лента → personal_food.
- Кофейни → personal_coffee. Рестораны/кафе/доставка → personal_restaurant.
- Хостинг/SaaS/облака → subscriptions. Регулярные банк/МФО → loan.
- Если не уверен (confidence < 0.7): для бизнес-расхода → other_business, для личного → personal_other.

is_personal=true ТОЛЬКО для personal_* категорий, для остальных — false.

Верни ТОЛЬКО валидный JSON-объект вида:
{"results":[{"id":"<id транзакции>","category":"<категория>","confidence":<число 0..1>,"is_personal":<true|false>}]}
В массиве должен быть РОВНО один объект на каждую входную транзакцию, поле id скопируй из входа без изменений.`;

/** Фолбэк для всего батча, когда Claude недоступен/вернул мусор. */
function fallbackBatch(batch: TxToClassify[]): TxClassification[] {
  return batch.map((tx) => ({
    id: tx.id,
    pnlCategory: 'other_business',
    confidence: 0,
    isPersonal: false,
  }));
}

/** Доходы классификатору не нужны — отдаём фиксированный результат. */
function incomeResult(tx: TxToClassify): TxClassification {
  return { id: tx.id, pnlCategory: 'income', confidence: 1, isPersonal: false };
}

/** Классифицирует один батч через Claude. Не бросает — на любой сбой даёт фолбэк. */
async function classifyBatch(batch: TxToClassify[]): Promise<TxClassification[]> {
  // Готовим компактный вход для модели. ИНН передаём как есть (у нас обычно null).
  const payload = batch.map((tx) => ({
    id: tx.id,
    counterparty: tx.counterparty,
    amount: tx.amount,
    description: tx.description,
    inn: tx.inn,
  }));

  try {
    const raw = await callClaude({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<user_input>${JSON.stringify(payload)}</user_input>`,
        },
      ],
      expectJson: true,
      maxTokens: MAX_TOKENS,
      model: config.CLAUDE_MODEL,
    });

    const items = ClaudeResponseSchema.parse(raw);

    // Индексируем ответ по id, чтобы устойчиво сопоставить даже при перестановке.
    const byId = new Map<string, z.infer<typeof ClaudeItemSchema>>();
    for (const item of items) {
      byId.set(item.id, item);
    }

    const result = batch.map((tx): TxClassification => {
      // Детерминированный override: переводы известным сотрудникам → ФОТ.
      if (tx.counterparty && PAYROLL_PAYEES.test(tx.counterparty)) {
        return { id: tx.id, pnlCategory: 'payroll', confidence: 1, isPersonal: false };
      }
      const item = byId.get(tx.id);
      if (item === undefined) {
        // Claude пропустил транзакцию — безопасный фолбэк по этой одной.
        return { id: tx.id, pnlCategory: 'other_business', confidence: 0, isPersonal: false };
      }
      const rawCategory: Category = item.category;
      // Личных трат у владельца нет (территориально за границей, карты РФ не
      // работают): покупки по корпоративной карте — это бизнес-расходы команды.
      // Поэтому любую personal_* схлопываем в other_business, is_personal=false.
      const category = PERSONAL_SET.has(rawCategory) ? 'other_business' : rawCategory;
      return {
        id: tx.id,
        pnlCategory: category,
        confidence: item.confidence,
        isPersonal: false,
      };
    });

    log.info(
      {
        batch_size: batch.length,
        returned: items.length,
        low_confidence: result.filter((r) => r.confidence < CONFIDENCE_THRESHOLD).length,
      },
      'classify_batch_ok'
    );

    return result;
  } catch (err) {
    log.warn(
      {
        batch_size: batch.length,
        error: err instanceof Error ? err.message : String(err),
      },
      'classify_batch_failed_fallback'
    );
    return fallbackBatch(batch);
  }
}

/**
 * Батч-классификация расходных транзакций.
 *
 * Доходы (flowType='income') классификатору не передаются — возвращают
 * фиксированный результат {category:'income'}. Расходы бьются на батчи по
 * BATCH_SIZE и классифицируются по одному вызову Claude на батч.
 *
 * Никогда не бросает: при сбое Claude/невалидном JSON возвращает для батча
 * фолбэк {pnlCategory:'other_business', confidence:0, isPersonal:false}.
 */
export async function classifyTransactions(txs: TxToClassify[]): Promise<TxClassification[]> {
  if (txs.length === 0) return [];

  const income = txs.filter((tx) => tx.flowType === 'income');
  const expenses = txs.filter((tx) => tx.flowType === 'expense');

  // US-103 «AI учится»: сперва применяем выученные правила (детерминированно),
  // эти операции не отправляем в Claude. company неизвестна на уровне выписки —
  // matchRule сопоставляет глобальные и любые правила по подстроке.
  let rules: Awaited<ReturnType<typeof listRules>> = [];
  try {
    rules = await listRules();
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, 'category_rules_load_failed');
  }

  // Сотрудники ФОТ: перевод этому человеку (counterparty совпал с match_pattern)
  // → payroll детерминированно, выше Claude. Источник — справочник employees.
  let payrollPatterns: { id: string; pattern: string }[] = [];
  try {
    payrollPatterns = await getActivePayrollPatterns();
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, 'payroll_patterns_load_failed');
  }

  const ruleResults: TxClassification[] = [];
  const needClaude: TxToClassify[] = [];
  for (const tx of expenses) {
    // 0. Сотрудник из справочника ФОТ → payroll.
    const cp = (tx.counterparty ?? '').toLowerCase();
    if (cp.length > 0 && payrollPatterns.some((p) => cp.includes(p.pattern))) {
      ruleResults.push({ id: tx.id, pnlCategory: 'payroll', confidence: 1, isPersonal: false });
      continue;
    }
    const rule = rules.length > 0 ? matchRule(rules, tx.counterparty, tx.description, null) : null;
    if (rule !== null) {
      ruleResults.push({
        id: tx.id,
        pnlCategory: rule.targetPnlCategory,
        confidence: rule.confidence,
        isPersonal: rule.targetPnlCategory.startsWith('personal_'),
      });
    } else {
      needClaude.push(tx);
    }
  }

  const expenseResults: TxClassification[] = [...ruleResults];
  for (let i = 0; i < needClaude.length; i += BATCH_SIZE) {
    const batch = needClaude.slice(i, i + BATCH_SIZE);
    const batchResults = await classifyBatch(batch);
    expenseResults.push(...batchResults);
  }

  const incomeResults = income.map(incomeResult);

  // Возвращаем в порядке исходного массива.
  const byId = new Map<string, TxClassification>();
  for (const r of [...expenseResults, ...incomeResults]) {
    byId.set(r.id, r);
  }
  return txs.map(
    (tx): TxClassification =>
      byId.get(tx.id) ?? { id: tx.id, pnlCategory: 'other_business', confidence: 0, isPersonal: false }
  );
}
