import { z } from 'zod';
import { sql } from '../db/client.js';
import { callClaude, ClaudeError } from './claude.js';
import { transcribeAudio } from './deepgram.js';
import { getRelevantMemory, saveMemory } from './vectorMemory.js';
import { childLogger } from '../utils/logger.js';
import type {
  ClassifyResult,
  ClassificationResult,
  Currency,
  EntityCode,
  DirectionCode,
  FlowType,
} from '../types.js';

/**
 * AI-классификатор транзакций.
 *
 * Принимает текст или голосовое (base64), вызывает Claude с системным
 * промптом, в который ДИНАМИЧЕСКИ подставляются справочники из БД
 * (entities, directions, categories, sources). Возвращает структурированную
 * транзакцию либо fallback при недоступности API.
 *
 * Правила (см. CLAUDE.md / .claude/rules/ai-classification.md):
 * - Пользовательский ввод ВСЕГДА оборачивается в <user_input>...</user_input>.
 * - Температура 0, max_tokens >= 1024 (задаются в services/claude.ts).
 * - Полный текст транзакции НЕ логируется — только metadata (confidence, category).
 */

const log = childLogger({ handler: 'classifier' });

const ClassifyInputSchema = z
  .object({
    text: z.string().min(1).max(2000).optional(),
    audioBase64: z.string().optional(),
    telegramId: z.bigint(),
    userRole: z.enum(['owner', 'accountant', 'manager']),
    managerDirections: z.array(z.string().uuid()).optional(),
    currentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((d) => d.text !== undefined || d.audioBase64 !== undefined, {
    message: 'text or audioBase64 required',
  });

export type ClassifyInput = z.input<typeof ClassifyInputSchema>;

// ─────────────────────────────────────────────────────────────
// Динамическая загрузка справочников из БД
// ─────────────────────────────────────────────────────────────

interface RefRow {
  code: string;
  display_name: string;
}

interface CategoryRefRow extends RefRow {
  flow_type: string;
  accounting_type: string;
}

interface ReferenceData {
  entities: RefRow[];
  directions: RefRow[];
  categories: CategoryRefRow[];
  sources: RefRow[];
}

async function loadReferenceData(): Promise<ReferenceData> {
  const [entities, directions, categories, sources] = await Promise.all([
    sql<RefRow[]>`SELECT code, display_name FROM entities ORDER BY code`,
    sql<RefRow[]>`SELECT code, display_name FROM directions WHERE is_active = true ORDER BY code`,
    sql<CategoryRefRow[]>`
      SELECT code, display_name, flow_type, accounting_type
      FROM categories
      WHERE is_active = true
      ORDER BY flow_type, code
    `,
    sql<RefRow[]>`SELECT code, display_name FROM sources WHERE is_active = true ORDER BY code`,
  ]);

  return {
    entities: [...entities],
    directions: [...directions],
    categories: [...categories],
    sources: [...sources],
  };
}

// ─────────────────────────────────────────────────────────────
// Системный промпт
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt(ref: ReferenceData, currentDate: string, memoryContext: string[]): string {
  const entityLines = ref.entities.map((e) => `  ${e.code} — ${e.display_name}`).join('\n');
  const directionLines = ref.directions.map((d) => `  ${d.code} — ${d.display_name}`).join('\n');
  const sourceLines = ref.sources.map((s) => `  ${s.code} — ${s.display_name}`).join('\n');
  const expenseCats = ref.categories
    .filter((c) => c.flow_type === 'expense')
    .map((c) => `  ${c.code} — ${c.display_name}`)
    .join('\n');
  const incomeCats = ref.categories
    .filter((c) => c.flow_type === 'income')
    .map((c) => `  ${c.code} — ${c.display_name}`)
    .join('\n');

  const memoryLines = memoryContext.length > 0
    ? '\n\nПоследний релевантный контекст пользователя:\n' +
      memoryContext.map((item, idx) => `  ${idx + 1}. ${item}`).join('\n')
    : '';

  return `Ты — финансовый классификатор для Карины Еремян. Карина ведёт два бизнеса:
- ИП Карина Еремян (УСН 6%) — основное юрлицо для образовательных продуктов
- ООО «Ассургина» (УСН 15%) — для крупных контрактов и команды

Два направления:
- "course_dpo" — Курс ДПО «Психология здоровья» (обучение Германской новой медицине через курс)
- "metanoia" — Клуб «Метанойя» (работа с психотравмами по Германской новой медицине)

Юрлица (entity_code):
${entityLines}

Направления (direction_code):
${directionLines}

Источники денег (source_code):
${sourceLines}

Категории доходов (category_code):
${incomeCats}

Категории расходов (category_code):
${expenseCats}${memoryLines}

Твоя задача — извлечь из текста (или голосового) структурированную транзакцию.
Если уверенности по полю < 0.7 — добавь название этого поля в массив needs_clarification.
ВСЕГДА возвращай валидный JSON в указанном формате. Никакого текста вокруг.

Правила:
- Если в тексте упомянуты "тысяч/тыс/к" — умножай сумму на 1000.
- Сумма (amount) указывается в МИНИМАЛЬНЫХ единицах валюты (копейки/центы): 25000 руб = 2500000.
- Если упомянута валюта (доллары/usd, евро/eur, тенге/kzt) — указывай её в currency. По умолчанию "RUB".
- amount_rub — сумма в копейках после пересчёта в рубли. Для RUB равна amount; для другой валюты оставь равной amount (пересчёт по курсу сделает система), а fx_rate оставь null.
- entity_code, direction_code, category_code, source_code — ТОЛЬКО из списков выше. Если не уверен — оставь null и добавь поле в needs_clarification.
- Дата operated по умолчанию — сегодня: ${currentDate}. occurred_at в формате YYYY-MM-DD.
- type: "income" для поступлений, "expense" для расходов.

Формат ответа (строго этот JSON, никакого текста вокруг):
{
  "type": "expense",
  "amount": 2500000,
  "currency": "RUB",
  "amount_rub": 2500000,
  "fx_rate": null,
  "entity_code": "ip_eremyan",
  "direction_code": "metanoia",
  "category_code": "exp_video",
  "source_code": "card_ip",
  "occurred_at": "${currentDate}",
  "description": "Оплата оператору за съёмки",
  "confidence": 0.92,
  "needs_clarification": [],
  "raw_transcript": null
}

Поля entity_code/direction_code/category_code/source_code/description/raw_transcript могут быть null.
needs_clarification — массив из значений: "entity", "direction", "category", "source", "amount", "currency".`;
}

// ─────────────────────────────────────────────────────────────
// Валидация ответа Claude
// ─────────────────────────────────────────────────────────────

const ClaudeResponseSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.union([z.number(), z.string()]),
  currency: z.string().default('RUB'),
  amount_rub: z.union([z.number(), z.string()]).nullable().optional(),
  fx_rate: z.number().nullable().optional(),
  entity_code: z.string().nullable().optional(),
  direction_code: z.string().nullable().optional(),
  category_code: z.string().nullable().optional(),
  source_code: z.string().nullable().optional(),
  occurred_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  needs_clarification: z
    .array(z.enum(['entity', 'direction', 'category', 'source', 'amount', 'currency']))
    .default([]),
  raw_transcript: z.string().nullable().optional(),
});

const VALID_CURRENCIES: ReadonlyArray<Currency> = ['RUB', 'USD', 'EUR', 'KZT', 'OTHER'];

function toBigIntAmount(value: number | string): bigint {
  if (typeof value === 'number') {
    return BigInt(Math.round(value));
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid amount from Claude: "${value}"`);
  }
  return BigInt(Math.round(num));
}

function normalizeCurrency(raw: string): Currency {
  const upper = raw.toUpperCase();
  return (VALID_CURRENCIES as readonly string[]).includes(upper) ? (upper as Currency) : 'OTHER';
}

/**
 * Сверяет code, полученный от Claude, со справочником из БД. Если кода нет
 * в справочнике — возвращает null (поле будет считаться неопределённым).
 */
function validateCode(code: string | null | undefined, valid: Set<string>): string | null {
  if (code === null || code === undefined) return null;
  return valid.has(code) ? code : null;
}

// ─────────────────────────────────────────────────────────────
// Основная функция
// ─────────────────────────────────────────────────────────────

export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  const parsed = ClassifyInputSchema.parse(input);

  let ref: ReferenceData;
  try {
    ref = await loadReferenceData();
  } catch (err) {
    log.error({ err }, 'classifier_reference_load_failed');
    throw err;
  }

  if (parsed.text === undefined) {
    try {
      const audioBuffer = Buffer.from(parsed.audioBase64 ?? '', 'base64');
      const transcript = await transcribeAudio(audioBuffer, 'audio/ogg');
      parsed.text = transcript;
    } catch (err) {
      log.warn({ err, has_audio: true }, 'classifier_audio_transcription_failed');
      return { fallback: true, error: 'Не удалось расшифровать голосовое. Опишите текстом.' };
    }
  }

  const memoryContext = await getRelevantMemory(parsed.telegramId, parsed.text ?? '');
  const system = buildSystemPrompt(ref, parsed.currentDate, memoryContext);

  // Пользовательский ввод ВСЕГДА оборачивается в <user_input>...</user_input>.
  const userContent: Array<Record<string, unknown>> = [
    { type: 'text', text: `<user_input>${parsed.text}</user_input>` },
  ];

  let raw: Record<string, unknown>;
  try {
    const result = await callClaude({
      system,
      messages: [{ role: 'user', content: userContent }],
      expectJson: true,
      maxTokens: 1024,
    });
    if (typeof result === 'string') {
      throw new ClaudeError('CLAUDE_INVALID_JSON', 'Ожидался JSON, получена строка');
    }
    raw = result;
  } catch (err) {
    // Любая недоступность/таймаут/невалидный JSON → fallback на ручной ввод.
    log.warn(
      { err, code: err instanceof ClaudeError ? err.code : undefined },
      'classifier_fallback'
    );
    return { fallback: true, error: 'Anthropic API недоступен' };
  }

  let response: z.infer<typeof ClaudeResponseSchema>;
  try {
    response = ClaudeResponseSchema.parse(raw);
  } catch (err) {
    log.warn({ err }, 'classifier_response_schema_invalid');
    return { fallback: true, error: 'Не удалось разобрать ответ AI' };
  }

  // Сверяем коды со справочниками.
  const entitySet = new Set(ref.entities.map((e) => e.code));
  const directionSet = new Set(ref.directions.map((d) => d.code));
  const categorySet = new Set(ref.categories.map((c) => c.code));
  const sourceSet = new Set(ref.sources.map((s) => s.code));

  const entityCode = validateCode(response.entity_code, entitySet) as EntityCode | null;
  const directionCode = validateCode(response.direction_code, directionSet) as DirectionCode | null;
  const categoryCode = validateCode(response.category_code, categorySet);
  const sourceCode = validateCode(response.source_code, sourceSet);

  const needs = new Set(response.needs_clarification);
  // Если Claude вернул несуществующий код — добавляем поле в уточнения.
  if (response.entity_code !== null && response.entity_code !== undefined && entityCode === null) {
    needs.add('entity');
  }
  if (response.direction_code !== null && response.direction_code !== undefined && directionCode === null) {
    needs.add('direction');
  }
  if (response.category_code !== null && response.category_code !== undefined && categoryCode === null) {
    needs.add('category');
  }
  if (response.source_code !== null && response.source_code !== undefined && sourceCode === null) {
    needs.add('source');
  }

  const amount = toBigIntAmount(response.amount);
  const currency = normalizeCurrency(response.currency);
  const amountRub =
    response.amount_rub !== null && response.amount_rub !== undefined
      ? toBigIntAmount(response.amount_rub)
      : currency === 'RUB'
        ? amount
        : amount;

  const result: ClassificationResult = {
    fallback: false,
    type: response.type as FlowType,
    amount,
    currency,
    amountRub,
    fxRate: response.fx_rate ?? null,
    entityCode: entityCode ?? ('ip_eremyan' as EntityCode),
    directionCode,
    categoryCode,
    sourceCode,
    occurredAt: response.occurred_at,
    description: response.description ?? null,
    confidence: response.confidence,
    needsClarification: [...needs],
    rawTranscript: response.raw_transcript ?? null,
  };

  await saveMemory(parsed.telegramId, parsed.text ?? '');

  // Логируем только metadata — без текста транзакции/описания.
  log.info(
    {
      confidence: result.confidence,
      type: result.type,
      category: result.categoryCode,
      needs_clarification: result.needsClarification,
    },
    'classifier_ok'
  );

  return result;
}
