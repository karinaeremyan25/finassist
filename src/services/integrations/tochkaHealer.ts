/**
 * Оплаты курса «Целитель» — НЕ деньги Карины: чужой поток, который идёт через
 * платёжные ссылки ООО Ассургина в Точке.
 *
 * В банковской выписке такие оплаты видны только как «Зачисление по QR коду ID …»
 * (СБП) или как общее зачисление по терминалу за день (карты) — без названия курса.
 * Название («111397 Счёт №…: Курс Целитель x 1.0») есть только в API интернет-
 * эквайринга Точки (/acquiring/v1.0/payments), поэтому берём его оттуда.
 */
import { z } from 'zod';
import { Agent } from 'undici';
import { config } from '../../config.js';
import { toKopecks } from '../../utils/money.js';
import { TOCHKA_CA } from './tochkaCa.js';

/** customerCode ООО ДПО «Ассургина» в Точке. */
const OOO_CUSTOMER_CODE = '305235334';
/** Первые оплаты Целителя — сентябрь 2026; берём с начала года с запасом. */
const HEALER_FROM = '2026-01-01';
const HEALER_RE = /целител/i;

const dispatcher = new Agent({ connect: { ca: TOCHKA_CA } });

const PaymentsSchema = z.object({
  Data: z.object({
    Operation: z.array(
      z.object({
        status: z.string(),
        amount: z.number(),
        purpose: z.string().nullable().optional(),
        paidAt: z.string().nullable().optional(),
        createdAt: z.string(),
        Items: z.array(z.object({ name: z.string() })).nullable().optional(),
      })
    ),
  }),
  Meta: z.object({ totalPages: z.number() }).optional(),
});

export interface HealerPayment {
  amount: bigint; // копейки
  date: string; // дата оплаты по МСК, 'YYYY-MM-DD'
}

/** Дата по МСК из ISO-строки с любым смещением. */
function mskDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

/** Все оплаченные (APPROVED) оплаты курса «Целитель» с начала года по сегодня. */
export async function fetchHealerPayments(toDate: string): Promise<HealerPayment[]> {
  const token = config.TOCHKA_JWT_TOKEN;
  if (token === undefined || token.length === 0) throw new Error('TOCHKA_JWT_TOKEN not set');

  const out: HealerPayment[] = [];
  for (let page = 1; page <= 50; page++) {
    const url =
      `https://enter.tochka.com/uapi/acquiring/v1.0/payments?customerCode=${OOO_CUSTOMER_CODE}` +
      `&fromDate=${HEALER_FROM}&toDate=${toDate}&perPage=1000&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      dispatcher,
      signal: AbortSignal.timeout(25_000),
    } as unknown as RequestInit);
    if (!res.ok) throw new Error(`Tochka acquiring payments → HTTP ${res.status}`);
    const data = PaymentsSchema.parse(await res.json());

    for (const op of data.Data.Operation) {
      if (op.status !== 'APPROVED') continue;
      const text = `${op.purpose ?? ''} ${(op.Items ?? []).map((i) => i.name).join(' ')}`;
      if (!HEALER_RE.test(text)) continue;
      out.push({ amount: toKopecks(op.amount), date: mskDate(op.paidAt ?? op.createdAt) });
    }
    if (page >= (data.Meta?.totalPages ?? 1)) break;
  }
  return out;
}
