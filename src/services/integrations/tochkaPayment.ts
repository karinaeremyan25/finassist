/**
 * Создание исходящего платежа в Точке «на подпись» (Create Payment For Sign).
 * POST /uapi/payment/v2.0/for-sign — платёж попадает в раздел «На подпись» в
 * интернет-банке Точки; деньги НЕ списываются, пока Карина не подпишет вручную.
 * Это безопасная модель: приложение только готовит платёж.
 *
 * Док: developers.tochka.com → Работа с платежами → Create Payment For Sign.
 */

import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ handler: 'tochkaPayment' });
const PAYMENT_URL = 'https://enter.tochka.com/uapi/payment/v2.0/for-sign';
const HTTP_TIMEOUT_MS = 30_000;

/** Расчётные счета-плательщики (номер 20 знаков + БИК 9 знаков). */
export const PAYER_ACCOUNTS = {
  ip: { accountCode: '40802810420000394172', bankCode: '044525104' },  // р/с ИП Еремян
  ooo: { accountCode: '40702810620000238882', bankCode: '044525104' }, // р/с ООО (после доверенности)
} as const;

/**
 * Реквизиты Единого налогового платежа (ЕНП) — единый для всех налогоплательщиков
 * РФ казначейский счёт. УСН/АУСН с 2023 платятся через ЕНП.
 * Проверено реальным запросом for-sign (HTTP 200): счёт, БИК, ЕКС, ИНН/КПП ФНС,
 * статус «01», КБК ЕНП. ОКТМО/основание/период = «0», УИН (supplierBillId) = «0».
 * Источник КБК ЕНП: 18201061201010000510.
 */
export const ENP_REQUISITES = {
  counterpartyAccountNumber: '03100643000000018500',
  counterpartyBankBic: '017003983',
  counterpartyBankCorrAccount: '40102810445370000059',
  counterpartyINN: '7727406020',
  counterpartyKPP: '770701001',
  counterpartyName: 'Казначейство России (ФНС России)',
  supplierBillId: '0',
  taxInfoStatus: '01',
  taxInfoKBK: '18201061201010000510',
  taxInfoOKATO: '0',
  taxInfoReasonCode: '0',
  taxInfoPeriod: '0',
  taxInfoDocumentNumber: '0',
  taxInfoDocumentDate: '0',
} as const;

export interface CreatePaymentInput {
  payer: 'ip' | 'ooo';
  counterpartyAccountNumber: string; // 20 знаков
  counterpartyBankBic: string;       // 9 знаков
  counterpartyInn: string | null;
  counterpartyName: string;
  amountRub: number;                 // рубли (например 30000.00)
  purpose: string;
  paymentNumber: number;
  paymentDate: string;               // YYYY-MM-DD (МСК, ≤ сегодня)
}

export interface CreatePaymentResult {
  ok: boolean;
  requestId?: string;
  redirectUrl?: string;
  status?: string;
  error?: string;
  noPaymentsScope?: boolean; // true, если у токена нет права payments
}

/**
 * Назначение платежа: убрать запрещённое тире «—», добавить НДС-оговорку (Точка
 * требует указывать НДС), обрезать до 210 символов. По умолчанию «Без НДС» —
 * у ИП/ООО на АУСН/УСН НДС нет (если в тексте уже есть «НДС», не трогаем).
 */
function sanitizePurpose(p: string): string {
  let s = p.replace(/—/g, '-').replace(/\s+/g, ' ').trim();
  if (!/ндс/i.test(s)) {
    s = `${s.replace(/[.\s]+$/, '')}. Без НДС.`;
  }
  return s.slice(0, 210);
}

/** Общая отправка тела на for-sign + единый разбор ответа/ошибок. */
async function postForSign(data: Record<string, unknown>): Promise<CreatePaymentResult> {
  const token = config.TOCHKA_JWT_TOKEN;
  if (!token) return { ok: false, error: 'Токен Точки не настроен' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(PAYMENT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ Data: data }),
      signal: controller.signal,
    });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      log.warn({ status: res.status }, 'tochka_payment_forbidden');
      return { ok: false, noPaymentsScope: true, error: 'У токена Точки нет права на платежи (payments). Перевыпусти токен с этим правом.' };
    }
    if (!res.ok) {
      log.warn({ status: res.status, body: text.slice(0, 400) }, 'tochka_payment_error');
      return { ok: false, error: `Точка вернула ошибку ${res.status}` };
    }

    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    const out = (parsed as { Data?: Record<string, unknown> } | null)?.Data ?? {};
    const requestId = typeof out['requestId'] === 'string' ? out['requestId'] : undefined;
    const redirectUrl = typeof out['redirectURL'] === 'string' ? out['redirectURL'] : undefined;
    const status = typeof out['status'] === 'string' ? out['status'] : undefined;

    log.info({ requestId, status }, 'tochka_payment_created');
    return { ok: true, requestId, redirectUrl, status };
  } catch (err) {
    log.error({ err: String(err) }, 'tochka_payment_request_failed');
    return { ok: false, error: 'Не удалось связаться с Точкой' };
  } finally {
    clearTimeout(timer);
  }
}

export async function createPaymentForSign(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  const payer = PAYER_ACCOUNTS[input.payer];
  return postForSign({
    accountCode: payer.accountCode,
    bankCode: payer.bankCode,
    counterpartyAccountNumber: input.counterpartyAccountNumber,
    counterpartyBankBic: input.counterpartyBankBic,
    counterpartyINN: input.counterpartyInn ?? '',
    counterpartyName: input.counterpartyName.slice(0, 160),
    paymentAmount: Math.round(input.amountRub * 100) / 100,
    paymentDate: input.paymentDate,
    paymentNumber: input.paymentNumber,
    paymentPriority: '5',
    paymentPurpose: sanitizePurpose(input.purpose),
  });
}

export interface CreateTaxPaymentInput {
  payer: 'ip' | 'ooo';
  amountRub: number;
  paymentNumber: number;
  paymentDate: string; // YYYY-MM-DD (МСК, ≤ сегодня)
  purpose?: string;    // по умолчанию «Единый налоговый платёж»
}

/**
 * Единый налоговый платёж (ЕНП) «на подпись». УСН/АУСН платятся через ЕНП:
 * деньги идут на единый казначейский счёт, ФНС распределяет сама. Реквизиты
 * фиксированы (ENP_REQUISITES), меняется лишь счёт-плательщик (ИП/ООО) и сумма.
 */
export async function createTaxPaymentForSign(input: CreateTaxPaymentInput): Promise<CreatePaymentResult> {
  const payer = PAYER_ACCOUNTS[input.payer];
  return postForSign({
    accountCode: payer.accountCode,
    bankCode: payer.bankCode,
    paymentAmount: Math.round(input.amountRub * 100) / 100,
    paymentDate: input.paymentDate,
    paymentNumber: input.paymentNumber,
    paymentPriority: '5',
    paymentPurpose: sanitizePurpose(input.purpose ?? 'Единый налоговый платёж'),
    ...ENP_REQUISITES,
  });
}
