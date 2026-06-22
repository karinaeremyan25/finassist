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

/** Назначение платежа: убрать запрещённое тире «—», обрезать до 210 символов. */
function sanitizePurpose(p: string): string {
  return p.replace(/—/g, '-').replace(/\s+/g, ' ').trim().slice(0, 210);
}

export async function createPaymentForSign(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  const token = config.TOCHKA_JWT_TOKEN;
  if (!token) return { ok: false, error: 'Токен Точки не настроен' };

  const payer = PAYER_ACCOUNTS[input.payer];
  const body = {
    Data: {
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
    },
  };

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
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      log.warn({ status: res.status }, 'tochka_payment_forbidden');
      return { ok: false, noPaymentsScope: true, error: 'У токена Точки нет права на платежи (payments). Перевыпусти токен с этим правом.' };
    }
    if (!res.ok) {
      log.warn({ status: res.status, body: text.slice(0, 300) }, 'tochka_payment_error');
      return { ok: false, error: `Точка вернула ошибку ${res.status}` };
    }

    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    const data = (parsed as { Data?: Record<string, unknown> } | null)?.Data ?? {};
    const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : undefined;
    const redirectUrl = typeof data['redirectURL'] === 'string' ? data['redirectURL'] : undefined;
    const status = typeof data['status'] === 'string' ? data['status'] : undefined;

    log.info({ requestId, status }, 'tochka_payment_created');
    return { ok: true, requestId, redirectUrl, status };
  } catch (err) {
    log.error({ err: String(err) }, 'tochka_payment_request_failed');
    return { ok: false, error: 'Не удалось связаться с Точкой' };
  } finally {
    clearTimeout(timer);
  }
}
