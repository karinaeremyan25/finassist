/**
 * AI-оркестратор (SPEC_FinAssist_v2.1 US-105).
 *
 *   POST /api/ai/commands           — разобрать команду (создаёт запись pending)
 *   POST /api/ai/commands/approve   — выполнить ранее разобранную команду (id в теле)
 *
 * Команда разбирается моделью-наставником (config.AI_MENTOR_MODEL = Opus) в
 * структурированный JSON-интент. Денежные действия выполняются ТОЛЬКО после
 * явного approve. Всё логируется в ai_commands.
 *
 * Безопасность денег: переклассификация по голосу не мутирует существующие
 * операции вслепую (это риск для учёта) — вместо этого создаётся правило
 * category_rules, которое применится к будущим операциям (US-103 «AI учится»).
 */

import { z } from 'zod';
import { config } from '../../config.js';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import { callClaude } from '../../services/claude.js';
import { logCommand, getCommand, finalizeCommand } from '../../db/repositories/aiCommands.js';
import { findContractorByName, createContractor, findPayeeByName, upsertPayeeRequisites } from '../../db/repositories/contractors.js';
import { createInvoice } from '../../db/repositories/invoices.js';
import { generatePaymentOrderPdf } from '../../services/paymentOrder.js';
import { createPaymentForSign } from '../../services/integrations/tochkaPayment.js';
import { fetchCounterpartyRequisites } from '../../services/integrations/tochkaSync.js';
import { sendDocumentToChat } from '../../services/telegramDoc.js';
import { upsertRule } from '../../db/repositories/categoryRules.js';
import { getPnlForPeriod, ENTITY_IDS, VALID_PNL_CATEGORIES } from '../../db/repositories/pnl.js';
import { generateMentorAnswer, MentorError } from '../../services/miniAppAi.js';
import { transcribeAudio, DeepgramError } from '../../services/deepgram.js';
import { importCardTransactions } from '../../db/repositories/cardImport.js';
import { toKopecks, rubles } from '../../utils/money.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'ai_commands' });

function invalidRequest(message: string): ApiResponse {
  return { status: 400, body: { error: { code: 'invalid_request', message } } };
}

function currentMonthMsk(): string {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── Разбор интента ─────────────────────────────────────────────────────────

const ParsedIntentSchema = z.object({
  type: z.enum(['create_invoice', 'create_payment', 'reclassify', 'query', 'unknown']),
  contractor_name: z.string().nullish(),
  amount_rub: z.number().nullish(),
  description: z.string().nullish(),
  to_category: z.string().nullish(),
  keyword: z.string().nullish(),
  is_tax: z.boolean().default(false),
  answer: z.string().nullish(),
  preview: z.string(),
  needs_clarification: z.boolean().default(false),
});
type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

const SYSTEM_PROMPT = `Ты — оркестратор финансовых команд для платформы FinAssist (ИП Карина Еремян + ООО «Ассургина»).
Пользователь присылает короткую команду (голос/текст). Может прийти ИСТОРИЯ предыдущих сообщений — используй её как контекст (например «формируй» относится к ранее обсуждённой платёжке). Определи намерение и верни СТРОГО валидный JSON.

Типы намерений (type):
- create_invoice — выставить счёт контрагенту (только ООО). Поля: contractor_name, amount_rub, description.
- create_payment — платёжное поручение: оплата контрагенту/сотруднику/сервису ИЛИ налог.
    Поля: contractor_name (кому платим — ФИО/название; для налога не нужно), amount_rub (сумма), description (назначение платежа), is_tax (true если это налог/ФНС/ЕНП).
    Примеры: «сформируй платёжку для Петровой на 30000 за бухуслуги» → contractor_name="Петрова", amount_rub=30000, description="бухгалтерские услуги", is_tax=false.
    «платёжка в ФНС на налог» → is_tax=true.
- reclassify — переместить операции в другую категорию расходов. Поля: to_category (одно из: payroll, marketing, loan, subscriptions, tax, payment_commission, other_business), keyword (по какому признаку: имя/назначение, например «коммунизм»).
- query — вопрос об аналитике/состоянии. Поле answer НЕ заполняй.
- unknown — не удалось понять.

Суммы: amount_rub — число в РУБЛЯХ (не копейки). «25K»/«25к» = 25000. «1.5 млн» = 1500000.
needs_clarification=true, если не хватает обязательного поля. Для create_payment (не налог) обязательны contractor_name и amount_rub — если чего-то нет, needs_clarification=true и в preview спроси недостающее («На какую сумму платёжка для Петровой?»).
preview — короткая фраза-подтверждение/уточнение на русском.

Верни ТОЛЬКО JSON-объект:
{"type":"...","contractor_name":null,"amount_rub":null,"description":null,"to_category":null,"keyword":null,"is_tax":false,"preview":"...","needs_clarification":false}`;

async function parseIntent(commandText: string, history?: string): Promise<ParsedIntent> {
  const userContent = history
    ? `Контекст предыдущих сообщений:\n${history}\n\nНовая команда:\n<user_input>${commandText}</user_input>`
    : `<user_input>${commandText}</user_input>`;
  const raw = await callClaude({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    expectJson: true,
    maxTokens: 1024,
    // Классификация «вопрос vs действие» — простая задача, держим на Sonnet
    // (config.CLAUDE_MODEL), чтобы не делать лишний Opus-вызов перед ответом
    // наставника. Сам совет/диалог наставника остаётся на Opus.
    model: config.CLAUDE_MODEL,
  });
  return ParsedIntentSchema.parse(raw);
}

// ── POST /api/ai/commands ──────────────────────────────────────────────────

const CommandBodySchema = z.object({
  command: z.string().min(1).max(2000),
});

export const aiCommandCreateHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = CommandBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest('Поле command обязательно');

    let intent: ParsedIntent;
    try {
      intent = await parseIntent(parsed.data.command);
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, 'ai_parse_failed');
      const id = await logCommand({
        userId: user.id,
        commandText: parsed.data.command,
        commandType: 'unknown',
        status: 'failed',
        aiResponse: { error: 'parse_failed' },
      });
      return { status: 200, body: { id, status: 'failed', ai_response: { preview: 'Не удалось разобрать команду. Переформулируйте.' }, needs_approval: false } };
    }

    const needsApproval =
      !intent.needs_clarification && (intent.type === 'create_invoice' || intent.type === 'create_payment' || intent.type === 'reclassify');

    const id = await logCommand({
      userId: user.id,
      commandText: parsed.data.command,
      commandType: intent.type,
      status: intent.needs_clarification ? 'failed' : 'pending',
      aiResponse: intent,
    });

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'ai_command_create', type: intent.type, id, latency_ms: Date.now() - start },
      'ai_command_create_ok'
    );

    return {
      status: 200,
      body: {
        id,
        status: intent.needs_clarification ? 'needs_clarification' : 'pending',
        ai_response: intent,
        needs_approval: needsApproval,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'ai_command_create', latency_ms: Date.now() - start }, 'ai_command_create_error');
    return invalidRequest('Ошибка обработки команды');
  }
};

// ── POST /api/ai/assistant — ЕДИНЫЙ AI: совет ИЛИ действие ──────────────────
// Наставник и оркестратор слиты в один вход (вкладка «AI»). Если сообщение —
// действие (счёт/платёжка/переклассификация) → возвращаем карточку на подтверждение.
// Иначе (вопрос/аналитика) → отвечаем как наставник с советами.

const AssistantBodySchema = z.object({
  question: z.string().min(1).max(2000),
  entity_id: z.string().uuid().nullish(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  context: z.string().nullish(),
  // История диалога (последние сообщения «роль: текст»), чтобы follow-up вроде
  // «формируй» / «исправь сумму» понимались по контексту.
  history: z.string().max(6000).nullish(),
});

export const aiAssistantHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = AssistantBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest('Поле question обязательно');
    const { question, entity_id, from, to, context, history } = parsed.data;

    // 1. Пытаемся понять, это действие или вопрос (с учётом истории диалога).
    let intent: ParsedIntent | null = null;
    try {
      intent = await parseIntent(question, history ?? undefined);
    } catch {
      intent = null; // не распарсилось — уходим в наставника
    }

    const isAction =
      intent !== null &&
      !intent.needs_clarification &&
      (intent.type === 'create_invoice' || intent.type === 'create_payment' || intent.type === 'reclassify');

    if (isAction && intent !== null) {
      const id = await logCommand({
        userId: user.id,
        commandText: question,
        commandType: intent.type,
        status: 'pending',
        aiResponse: intent,
      });
      log.info(
        { telegram_id: user.telegramId.toString(), handler: 'ai_assistant', kind: 'action', type: intent.type, latency_ms: Date.now() - start },
        'ai_assistant_action'
      );
      return {
        status: 200,
        body: { kind: 'action', id, command_type: intent.type, intent, needs_approval: true },
      };
    }

    // Если действие без деталей — просим уточнить (короткий ответ-подсказка).
    if (intent !== null && intent.needs_clarification) {
      return { status: 200, body: { kind: 'answer', answer: intent.preview, source: 'orchestrator' } };
    }

    // 2. Вопрос/аналитика → наставник с советами.
    try {
      const r = await generateMentorAnswer({
        question,
        telegramId: user.telegramId,
        entityId: entity_id ?? null,
        from: from ?? null,
        to: to ?? null,
        context: history ? `${context ?? ''}\nИстория диалога:\n${history}`.trim() : context ?? null,
      });
      log.info(
        { telegram_id: user.telegramId.toString(), handler: 'ai_assistant', kind: 'answer', latency_ms: Date.now() - start },
        'ai_assistant_answer'
      );
      return { status: 200, body: { kind: 'answer', answer: r.answer, source: r.source } };
    } catch (err) {
      if (err instanceof MentorError) {
        const hint: Record<string, string> = {
          off_topic: 'Я помогаю с финансами и аналитикой этого бизнеса, а также создаю счета, считаю налог и переклассифицирую расходы.',
          insufficient_data: 'Недостаточно данных за выбранный период — попробуйте расширить период.',
          ai_unavailable: 'AI временно недоступен, попробуйте чуть позже.',
          invalid_request: 'Вопрос не может быть пустым.',
        };
        return { status: 200, body: { kind: 'answer', answer: hint[err.code] ?? 'Не удалось ответить.', source: 'mentor' } };
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'ai_assistant', latency_ms: Date.now() - start }, 'ai_assistant_error');
    return { status: 200, body: { kind: 'answer', answer: 'Произошла ошибка. Попробуйте ещё раз.', source: 'error' } };
  }
};

// ── POST /api/ai/transcribe — голосовая диктовка (Deepgram) ─────────────────
// Аудио приходит base64 в JSON — это работает одинаково на VPS (http.ts парсит
// JSON) и на Vercel (req.body уже распарсен; сырой поток rawReq там недоступен).
// Лимит тела (http.ts MAX_BODY_BYTES=256 КБ) → короткие команды (до ~минуты opus).

const TranscribeBodySchema = z.object({
  audio_base64: z.string().min(1),
  mime: z.string().default('audio/webm'),
});

export const aiTranscribeHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = TranscribeBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest('Нужно поле audio_base64');

    const buffer = Buffer.from(parsed.data.audio_base64, 'base64');
    if (buffer.length === 0) return invalidRequest('Пустая аудиозапись');

    const text = await transcribeAudio(buffer, parsed.data.mime);
    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'ai_transcribe', bytes: buffer.length, latency_ms: Date.now() - start },
      'ai_transcribe_ok'
    );
    return { status: 200, body: { text } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    if (err instanceof DeepgramError) {
      const msg =
        err.code === 'DEEPGRAM_NOT_CONFIGURED'
          ? 'Голосовой ввод не настроен (нет ключа Deepgram).'
          : 'Не удалось распознать речь, попробуйте ещё раз.';
      return { status: 200, body: { ok: false, error: msg } };
    }
    log.error({ err, handler: 'ai_transcribe', latency_ms: Date.now() - start }, 'ai_transcribe_error');
    return { status: 200, body: { ok: false, error: 'Ошибка распознавания' } };
  }
};

// ── POST /api/ai/import-image — распознать операции со скриншота карты ──────
// Карта Лилианы и др. физ-карты API не имеют → заносим по скриншоту. Vision
// (Opus) извлекает операции, клиент показывает на проверку, затем /import/confirm.

const VisionTxSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_rub: z.union([z.number(), z.string()]),
  direction: z.enum(['in', 'out']).default('out'),
  counterparty: z.string().default(''),
  description: z.string().nullish(),
});
const VisionResponseSchema = z.object({ transactions: z.array(VisionTxSchema) });

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const ImportImageBodySchema = z.object({
  image_base64: z.string().min(1),
  mime: z.string().default('image/jpeg'),
});

export const aiImportImageHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = ImportImageBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest('Нужно поле image_base64');
    const mime = ALLOWED_IMAGE_MIME.has(parsed.data.mime) ? parsed.data.mime : 'image/jpeg';

    const year = new Date().getUTCFullYear();
    const system = `Ты извлекаешь операции из СКРИНШОТА банковской выписки или истории карты. Верни СТРОГО валидный JSON.
Для КАЖДОЙ операции: date (YYYY-MM-DD; если год не виден — ${year}), amount_rub (число в рублях, без знака и пробелов), direction ('out' — трата/перевод, 'in' — поступление), counterparty (кому/от кого — ФИО или название; если не видно — ""), description (назначение кратко).
Игнорируй итоги, остаток, сводки кешбэка — только отдельные операции.
Ответ ТОЛЬКО JSON: {"transactions":[{"date":"YYYY-MM-DD","amount_rub":0,"direction":"out","counterparty":"...","description":"..."}]}`;

    const raw = await callClaude({
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: parsed.data.image_base64 } },
            { type: 'text', text: 'Извлеки все операции из этого скриншота.' },
          ],
        },
      ],
      expectJson: true,
      maxTokens: 4096,
      model: config.AI_MENTOR_MODEL,
    });

    const vision = VisionResponseSchema.safeParse(raw);
    if (!vision.success) {
      return { status: 200, body: { ok: false, error: 'Не удалось распознать операции на скриншоте' } };
    }

    const transactions = vision.data.transactions.map((t) => ({
      date: t.date,
      amount_rub: typeof t.amount_rub === 'string' ? Number(t.amount_rub.replace(/\s/g, '').replace(',', '.')) : t.amount_rub,
      direction: t.direction,
      counterparty: t.counterparty,
      description: t.description ?? null,
    })).filter((t) => Number.isFinite(t.amount_rub) && t.amount_rub > 0);

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'ai_import_image', extracted: transactions.length, latency_ms: Date.now() - start },
      'ai_import_image_ok'
    );
    return { status: 200, body: { ok: true, transactions } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'ai_import_image', latency_ms: Date.now() - start }, 'ai_import_image_error');
    return { status: 200, body: { ok: false, error: 'Ошибка распознавания скриншота' } };
  }
};

// ── POST /api/ai/import/confirm — занести распознанные операции ─────────────

const ConfirmTxSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_rub: z.union([z.number(), z.string()]),
  direction: z.enum(['in', 'out']).default('out'),
  counterparty: z.string().default(''),
  description: z.string().nullish(),
});
const ConfirmBodySchema = z.object({
  transactions: z.array(ConfirmTxSchema).min(1).max(200),
  card: z.string().max(40).optional(), // метка карты (по умолчанию — Лилиана)
});

const CARD_PRESETS: Record<string, { code: string; name: string }> = {
  lilia: { code: 'card_lilia', name: 'Карта Лилианы' },
};

export const aiImportConfirmHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = ConfirmBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest('Нужен список transactions');

    const preset = CARD_PRESETS[parsed.data.card ?? 'lilia'] ?? CARD_PRESETS['lilia']!;
    const txs = parsed.data.transactions.map((t) => ({
      date: t.date,
      amountKop: toKopecks(t.amount_rub),
      direction: t.direction,
      counterparty: t.counterparty,
      description: t.description ?? null,
    }));

    const result = await importCardTransactions(txs, preset.code, preset.name, user.telegramId);

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'ai_import_confirm', created: result.created, skipped: result.skipped, latency_ms: Date.now() - start },
      'ai_import_confirm_ok'
    );
    return {
      status: 200,
      body: {
        ok: true,
        created: result.created,
        skipped: result.skipped,
        payroll: result.payroll,
        total: result.totalKop,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'ai_import_confirm', latency_ms: Date.now() - start }, 'ai_import_confirm_error');
    return { status: 200, body: { ok: false, error: 'Не удалось занести операции' } };
  }
};

// ── POST /api/ai/commands/approve ──────────────────────────────────────────

const ApproveBodySchema = z.object({
  id: z.string().uuid(),
  approved: z.boolean(),
});

export const aiCommandApproveHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = ApproveBodySchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest('Поля id (uuid) и approved обязательны');

    const cmd = await getCommand(parsed.data.id);
    if (cmd === null) return { status: 404, body: { error: { code: 'not_found', message: 'Команда не найдена' } } };
    if (cmd.status !== 'pending') return invalidRequest('Команда уже обработана');

    if (!parsed.data.approved) {
      await finalizeCommand(cmd.id, 'rejected', { note: 'Отклонено пользователем' });
      return { status: 200, body: { status: 'rejected' } };
    }

    const intent = ParsedIntentSchema.safeParse(cmd.aiResponse);
    if (!intent.success) {
      await finalizeCommand(cmd.id, 'failed', { error: 'bad_intent' });
      return invalidRequest('Невалидный разбор команды');
    }

    const result = await executeIntent(intent.data, user.id, user.telegramId);

    await finalizeCommand(cmd.id, result.ok ? 'executed' : 'failed', result.payload);

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'ai_command_approve', type: intent.data.type, ok: result.ok, latency_ms: Date.now() - start },
      'ai_command_approve_ok'
    );

    return { status: 200, body: { status: result.ok ? 'executed' : 'failed', result: result.payload } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'ai_command_approve', latency_ms: Date.now() - start }, 'ai_command_approve_error');
    return invalidRequest('Ошибка выполнения команды');
  }
};

// ── Исполнение интента ─────────────────────────────────────────────────────

interface ExecResult {
  ok: boolean;
  payload: Record<string, unknown>;
}

/** Сегодняшняя дата в МСК как DD.MM.YYYY и компактный номер документа. */
function todayMskParts(): { date: string; number: string } {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const dd = String(msk.getUTCDate()).padStart(2, '0');
  const mm = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = msk.getUTCFullYear();
  const hh = String(msk.getUTCHours()).padStart(2, '0');
  const mi = String(msk.getUTCMinutes()).padStart(2, '0');
  return { date: `${dd}.${mm}.${yyyy}`, number: `${yyyy}${mm}${dd}-${hh}${mi}` };
}

async function executeIntent(intent: ParsedIntent, userId: string, telegramId: bigint): Promise<ExecResult> {
  if (intent.type === 'create_invoice') {
    if (!intent.contractor_name || intent.amount_rub == null) {
      return { ok: false, payload: { note: 'Не хватает контрагента или суммы' } };
    }
    // Счета — только ООО. Находим контрагента или создаём.
    let contractor = await findContractorByName(intent.contractor_name, 'ooo');
    if (contractor === null) {
      const id = await createContractor({
        companyId: 'ooo',
        name: intent.contractor_name,
        phone: null,
        email: null,
        inn: null,
        contractorType: 'company',
        matchPattern: null,
      });
      contractor = { id, name: intent.contractor_name };
    }
    const amount = toKopecks(intent.amount_rub);
    const invoice = await createInvoice({
      contractorId: contractor.id,
      amount,
      description: intent.description ?? null,
      dueDate: null,
      createdBy: userId,
    });
    return {
      ok: true,
      payload: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoiceNumber,
        contractor: contractor.name,
        amount: invoice.amount,
        pdf_url: null,
        note: 'Счёт создан в статусе draft (PDF — отдельным шагом).',
      },
    };
  }

  if (intent.type === 'create_payment') {
    const { date, number } = todayMskParts();

    // (А) НАЛОГ: АУСН «доходы» 8% с ВАЛОВЫХ продаж (полная сумма на Продамус/Lava,
    // включая «в пути»), БЕЗ вычета комиссии. Считаем по ИП и ООО отдельно.
    if (intent.is_tax) {
      const period = currentMonthMsk();
      const ipPnl = await getPnlForPeriod(period, [ENTITY_IDS.ip]);
      const oooPnl = await getPnlForPeriod(period, [ENTITY_IDS.ooo]);
      const ipTax = BigInt(Math.round(Number(ipPnl.incomeTotal) * 0.08));
      const oooTax = BigInt(Math.round(Number(oooPnl.incomeTotal) * 0.08));
      const totalTax = ipTax + oooTax;

      return {
        ok: true,
        payload: {
          period,
          ip_income: Number(ipPnl.incomeTotal),
          ip_tax: Number(ipTax),
          ooo_income: Number(oooPnl.incomeTotal),
          ooo_tax: Number(oooTax),
          total_tax: Number(totalTax),
          note:
            `Налог АУСН 8% с валовых продаж за ${period} (включая «в пути», без вычета комиссии):\n` +
            `• ИП: ${rubles(ipTax)} (доход ${rubles(ipPnl.incomeTotal)})\n` +
            `• ООО: ${rubles(oooTax)} (доход ${rubles(oooPnl.incomeTotal)})\n` +
            `Итого: ${rubles(totalTax)}. Платёж проведём через Точку — как подключим оплату из приложения. Срок АУСН — до 25 числа следующего месяца.`,
        },
      };
    }

    // (Б) ОПЛАТА ПОЛУЧАТЕЛЮ: реквизиты из базы.
    if (!intent.contractor_name || intent.amount_rub == null) {
      return { ok: false, payload: { note: 'Не хватает получателя или суммы платёжки' } };
    }
    const amount = toKopecks(intent.amount_rub);
    const payee = await findPayeeByName(intent.contractor_name);
    let payeeName = payee?.name ?? intent.contractor_name;
    let payeeInn = payee?.inn ?? null;
    let payeeAccount = payee?.bankAccount ?? null;
    let payeeBik = payee?.bik ?? null;
    const purpose = intent.description ?? 'Оплата';

    // Реквизитов нет в базе → подтягиваем из выписки Точки (по прошлым платежам).
    // Берём оттуда и реальное полное имя получателя (например «ИП Петрова Татьяна»).
    if (!payeeAccount || !payeeBik) {
      const found = await fetchCounterpartyRequisites(intent.contractor_name);
      if (found?.account && found.bik) {
        payeeName = found.name;
        payeeInn = found.inn ?? payeeInn;
        payeeAccount = found.account;
        payeeBik = found.bik;
        // Сохраняем на будущее, чтобы в следующий раз не искать.
        try {
          await upsertPayeeRequisites({
            contractorId: payee?.kind === 'contractor' ? payee.id : null,
            name: found.name, inn: found.inn, bankAccount: found.account, bik: found.bik,
          });
        } catch { /* не критично */ }
      }
    }

    // 1) Если есть р/с и БИК — создаём платёж В ТОЧКЕ «на подпись» (деньги не
    //    спишутся, пока Карина не подпишет в банке).
    if (payeeAccount && payeeBik) {
      const m = new Date(Date.now() + 3 * 60 * 60 * 1000);
      const p2 = (n: number): string => String(n).padStart(2, '0');
      const ymd = `${m.getUTCFullYear()}-${p2(m.getUTCMonth() + 1)}-${p2(m.getUTCDate())}`;
      const payNum = Number(`${p2(m.getUTCDate())}${p2(m.getUTCHours())}${p2(m.getUTCMinutes())}`);
      const pay = await createPaymentForSign({
        payer: 'ip',
        counterpartyAccountNumber: payeeAccount.replace(/\D/g, '').slice(0, 20),
        counterpartyBankBic: payeeBik.replace(/\D/g, '').slice(0, 9),
        counterpartyInn: payeeInn,
        counterpartyName: payeeName,
        amountRub: Number(amount) / 100,
        purpose,
        paymentNumber: payNum,
        paymentDate: ymd,
      });
      if (pay.ok) {
        return {
          ok: true,
          payload: {
            payee: payeeName,
            amount: Number(amount),
            tochka_payment: true,
            redirect_url: pay.redirectUrl ?? null,
            note: `✅ Платёж на ${rubles(amount)} для «${payeeName}» создан в Точке и ждёт твоей подписи. Открой Точку → «На подпись» → подтверди — тогда спишется.${pay.redirectUrl ? ` [Открыть для подписи](${pay.redirectUrl})` : ''}`,
          },
        };
      }
      // Не удалось через Точку → откат на PDF с понятной причиной.
      const reason = pay.noPaymentsScope
        ? 'У токена Точки нет права «Платежи» — перевыпусти токен с этим правом. Пока прислал PDF-черновик.'
        : `Не удалось создать платёж в Точке (${pay.error}). Прислал PDF-черновик.`;
      const pdf = await generatePaymentOrderPdf({
        number, date, payerName: 'ИП Карина Еремян', payerInn: null,
        payeeName, payeeInn, payeeAccount, payeeBic: payeeBik,
        amountKopecks: amount, purpose,
      });
      const sent = await sendDocumentToChat(telegramId, `platezhka_${number}.pdf`, pdf, 'application/pdf', `Платёжка (черновик) для «${payeeName}» на ${rubles(amount)}.`);
      return { ok: true, payload: { payee: payeeName, amount: Number(amount), pdf_sent: sent, note: reason } };
    }

    // 2) Реквизитов нет ни в базе, ни в выписке Точки → PDF + просьба заполнить.
    const pdf = await generatePaymentOrderPdf({
      number, date, payerName: 'ИП Карина Еремян', payerInn: null,
      payeeName, payeeInn, payeeAccount: null, payeeBic: null,
      amountKopecks: amount, purpose,
    });
    const sent = await sendDocumentToChat(telegramId, `platezhka_${number}.pdf`, pdf, 'application/pdf', `Платёжка (черновик) для «${payeeName}» на ${rubles(amount)}. Проверьте реквизиты.`);
    return {
      ok: true,
      payload: {
        payee: payeeName,
        amount: Number(amount),
        pdf_sent: sent,
        note: sent
          ? `PDF платёжки отправлен в чат. Реквизиты получателя не нашлись в Точке (нет прошлых платежей этому контрагенту) — заполни р/с и БИК в карточке контрагента «${payeeName}», и платёж пойдёт прямо в Точку.`
          : 'Не удалось отправить PDF в чат.',
      },
    };
  }

  if (intent.type === 'reclassify') {
    if (!intent.to_category || !intent.keyword) {
      return { ok: false, payload: { note: 'Нужны категория и ключевое слово' } };
    }
    if (!(VALID_PNL_CATEGORIES as readonly string[]).includes(intent.to_category)) {
      return { ok: false, payload: { note: `Неизвестная категория: ${intent.to_category}` } };
    }
    // Безопасно: создаём правило (применится к будущим операциям), существующие
    // записи по голосу не мутируем — точечная правка делается на экране Отчётов.
    const keyword = intent.keyword.toLowerCase().trim();
    await upsertRule(keyword, intent.to_category, null, userId);
    return {
      ok: true,
      payload: {
        rule_created: true,
        keyword,
        target_category: intent.to_category,
        note: 'Правило сохранено — будущие операции с этим признаком пойдут в выбранную категорию. Текущие операции правьте точечно на экране Отчётов.',
      },
    };
  }

  return { ok: false, payload: { note: 'Тип команды не выполняется автоматически' } };
}

/** Диспатч /api/ai/commands: query отвечаем сразу, остальное — pending. */
export const aiCommandsHandler: ApiHandler = aiCommandCreateHandler;
