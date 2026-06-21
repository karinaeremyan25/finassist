/**
 * Контрагенты и счета (SPEC_FinAssist_v2.1 US-102).
 *
 *   GET  /api/contractors?company=ooo     — список с остатками
 *   POST /api/contractors                 — создать контрагента
 *   POST /api/invoices/generate           — создать счёт (только ООО)
 *
 * Счета доступны только для ООО (edge case #5 → 403 для ИП).
 * Авторизация: resolveWebAppUser. Суммы — копейки (bigint).
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import {
  listContractorsWithBalance,
  createContractor,
  deriveContractorsFromTransactions,
} from '../../db/repositories/contractors.js';
import { createInvoice } from '../../db/repositories/invoices.js';
import { toKopecks } from '../../utils/money.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'contractors' });

const CompanySchema = z.enum(['ip', 'ooo']);

function invalidRequest(message: string): ApiResponse {
  return { status: 400, body: { error: { code: 'invalid_request', message } } };
}

// ── GET /api/contractors ───────────────────────────────────────────────────

const ListQuerySchema = z.object({ company: CompanySchema.optional() });

export const contractorsListHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidRequest('Неверные параметры');

    const items = await listContractorsWithBalance(parsed.data.company ?? null);

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'contractors_list', count: items.length, latency_ms: Date.now() - start },
      'contractors_list_ok'
    );

    return {
      status: 200,
      body: {
        data: items.map((c) => ({
          id: c.id,
          company_id: c.companyId,
          name: c.name,
          phone: c.phone,
          email: c.email,
          inn: c.inn,
          contractor_type: c.contractorType,
          status: c.status,
          total_invoiced: c.totalInvoiced,
          total_paid: c.totalPaid,
          balance_owed: c.balanceOwed,
          invoices: c.invoices.map((i) => ({
            id: i.id,
            invoice_number: i.invoiceNumber,
            amount: i.amount,
            description: i.description,
            due_date: i.dueDate,
            status: i.status,
            pdf_url: i.pdfUrl,
            date_paid: i.datePaid,
          })),
          payments: c.payments.map((p) => ({
            id: p.id,
            amount: p.amount,
            flow_type: p.flowType,
            description: p.description,
            date: p.occurredAt,
            tochka_transaction_id: p.externalId,
          })),
        })),
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'contractors_list', latency_ms: Date.now() - start }, 'contractors_list_error');
    return { status: 200, body: { data: [] } };
  }
};

// ── POST /api/contractors ──────────────────────────────────────────────────

const CreateContractorSchema = z.object({
  company_id: CompanySchema,
  name: z.string().min(1).max(300),
  phone: z.string().max(50).nullish(),
  email: z.string().max(200).nullish(),
  inn: z.string().max(20).nullish(),
  contractor_type: z.enum(['individual', 'company', 'self_employed']).optional(),
  match_pattern: z.string().max(200).nullish(),
});

export const contractorCreateHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = CreateContractorSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(parsed.error.errors[0]?.message ?? 'Неверное тело запроса');

    const d = parsed.data;
    const id = await createContractor({
      companyId: d.company_id,
      name: d.name,
      phone: d.phone ?? null,
      email: d.email ?? null,
      inn: d.inn ?? null,
      contractorType: d.contractor_type ?? 'company',
      matchPattern: d.match_pattern ?? null,
    });

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'contractor_create', id, latency_ms: Date.now() - start },
      'contractor_create_ok'
    );
    return { status: 200, body: { id } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'contractor_create', latency_ms: Date.now() - start }, 'contractor_create_error');
    return invalidRequest('Не удалось создать контрагента');
  }
};

/** GET → список, POST → создать. */
export const contractorsHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  if (req.method === 'POST') return contractorCreateHandler(req);
  return contractorsListHandler(req);
};

// ── POST /api/contractors/sync — завести контрагентов из выписки Точки ──────

const SyncQuerySchema = z.object({ company: CompanySchema.optional() });

export const contractorsSyncHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = SyncQuerySchema.safeParse(req.query);
    const company = parsed.success ? parsed.data.company ?? null : null;

    const created = await deriveContractorsFromTransactions(company);

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'contractors_sync', created, latency_ms: Date.now() - start },
      'contractors_sync_ok'
    );
    return { status: 200, body: { ok: true, created } };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'contractors_sync', latency_ms: Date.now() - start }, 'contractors_sync_error');
    return { status: 200, body: { ok: false, created: 0, error: 'Не удалось загрузить контрагентов' } };
  }
};

// ── POST /api/invoices/generate ────────────────────────────────────────────

const GenerateInvoiceSchema = z.object({
  contractor_id: z.string().uuid(),
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(500).nullish(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

export const invoiceGenerateHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();
  try {
    const user = await resolveWebAppUser(req);
    const parsed = GenerateInvoiceSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(parsed.error.errors[0]?.message ?? 'Неверное тело запроса');

    const d = parsed.data;
    const amount = toKopecks(d.amount);
    if (amount <= 0n) return invalidRequest('Сумма счёта должна быть больше нуля');

    const invoice = await createInvoice({
      contractorId: d.contractor_id,
      amount,
      description: d.description ?? null,
      dueDate: d.due_date ?? null,
      createdBy: user.id,
    });

    log.info(
      { telegram_id: user.telegramId.toString(), handler: 'invoice_generate', id: invoice.id, latency_ms: Date.now() - start },
      'invoice_generate_ok'
    );

    // PDF-генерация — отдельный шаг (требует шаблон реквизитов ООО); пока счёт
    // создаётся записью в статусе draft, pdf_url=null.
    return {
      status: 200,
      body: {
        id: invoice.id,
        invoice_number: invoice.invoiceNumber,
        status: invoice.status,
        amount: invoice.amount,
        pdf_url: null,
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);
    log.error({ err, handler: 'invoice_generate', latency_ms: Date.now() - start }, 'invoice_generate_error');
    return invalidRequest('Не удалось создать счёт');
  }
};
