/**
 * Генерация PDF «Платёжное поручение (черновик)» с кириллицей (встроенный Roboto).
 * Это НЕ официальная форма 0401060 — управленческий черновик с суммой, получателем
 * и назначением для проверки бухгалтером. Недостающие реквизиты помечены «—».
 */

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { ROBOTO_REGULAR_BASE64 } from '../server/assets/robotoFont.js';
import { rubles } from '../utils/money.js';

export interface PaymentOrderData {
  number: string;
  date: string; // DD.MM.YYYY
  payerName: string;
  payerInn: string | null;
  payeeName: string;
  payeeInn: string | null;
  payeeAccount: string | null;
  payeeBic: string | null;
  amountKopecks: bigint;
  purpose: string;
}

export async function generatePaymentOrderPdf(d: PaymentOrderData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(Buffer.from(ROBOTO_REGULAR_BASE64, 'base64'), { subset: true });

  const page = pdf.addPage([595, 842]); // A4
  const { height } = page.getSize();
  const left = 48;
  let y = height - 56;
  const ink = rgb(0.08, 0.1, 0.1);
  const muted = rgb(0.4, 0.43, 0.43);

  const draw = (text: string, size: number, color = ink, x = left): void => {
    page.drawText(text, { x, y, size, font, color });
  };

  draw('ПЛАТЁЖНОЕ ПОРУЧЕНИЕ (черновик)', 16, ink);
  y -= 22;
  draw(`№ ${d.number}    от ${d.date}`, 11, muted);
  y -= 30;

  const row = (label: string, value: string): void => {
    page.drawText(label, { x: left, y, size: 10, font, color: muted });
    page.drawText(value, { x: left + 150, y, size: 11, font, color: ink });
    y -= 22;
  };

  row('Плательщик', d.payerName);
  row('ИНН плательщика', d.payerInn ?? '—');
  y -= 8;
  row('Получатель', d.payeeName);
  row('ИНН получателя', d.payeeInn ?? '— (заполнить)');
  row('Расчётный счёт', d.payeeAccount ?? '— (заполнить)');
  row('БИК банка', d.payeeBic ?? '— (заполнить)');
  y -= 8;

  page.drawText('Сумма', { x: left, y, size: 10, font, color: muted });
  page.drawText(rubles(d.amountKopecks), { x: left + 150, y, size: 15, font, color: ink });
  y -= 30;

  page.drawText('Назначение платежа', { x: left, y, size: 10, font, color: muted });
  y -= 18;
  // Перенос длинного назначения по словам.
  const maxWidth = 595 - left * 2;
  const words = d.purpose.split(/\s+/);
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(test, 11) > maxWidth) {
      page.drawText(line, { x: left, y, size: 11, font, color: ink });
      y -= 16;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x: left, y, size: 11, font, color: ink });
    y -= 16;
  }

  y -= 24;
  page.drawText('Черновик сформирован FinAssist. Проверьте реквизиты получателя перед оплатой.', {
    x: left,
    y,
    size: 9,
    font,
    color: muted,
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
