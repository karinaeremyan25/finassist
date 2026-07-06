/**
 * Полный бэкфилл Продамуса из выгрузки «Успешные оплаты» (paylist.csv).
 *
 * Модель (обратная связь бухгалтера):
 *   доход = ВАЛОВЫЙ (колонка «Сумма») + отдельный расход комиссии (Сумма − Расчетная).
 * Статус «в пути»:
 *   «Выплачен» → completed (деньги дошли на ИП);
 *   «Получен»/«Обработан» → pending (ещё в Продамусе, деньги в пути).
 *
 * Все приходы Продамуса — ИП. Роутинг курс/клуб — только для категории-направления.
 * Идемпотентно: для каждого заказа удаляем прежние prodamus_<id> и prodamus_comm_<id>
 * и вставляем заново с валовыми суммами/комиссией/статусом (правит старые нетто-записи).
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });

const IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const SRC = (await sql`SELECT id FROM sources WHERE code='prodamus'`)[0].id;
const cats = Object.fromEntries((await sql`SELECT code,id FROM categories WHERE code IN ('prodamus_course','prodamus_club')`).map(r=>[r.code,r.id]));
const OWNER = BigInt(process.env.OWNER_TG_ID);

const text = (await readFile(process.env.HOME + '/Downloads/paylist.csv','utf8')).replace(/^﻿/,'');
const lines = text.split(/\r?\n/).filter(l=>l.trim());
function pl(line){const o=[];let c='',q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){c+='"';i++;}else q=!q;}else if(ch===';'&&!q){o.push(c);c='';}else c+=ch;}o.push(c);return o;}
const kop = s => BigInt(Math.round(Number(String(s).replace(',','.'))*100));
const toDate = s => { const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(s||''); return m?`${m[1]}-${m[2]}-${m[3]}`:null; };
const isCourse = t => /курс/i.test(t) && /психолог/i.test(t);

let inc=0, comm=0, grossSum=0n, commSum=0n, pendGross=0n, pendNet=0n, doneGross=0n, skipped=0;
let course=0, club=0;

for (let i=1;i<lines.length;i++){
  const c = pl(lines[i]);
  const id = (c[0]||'').replace(/"/g,'').trim();
  if (!id) { skipped++; continue; }
  const status = (c[12]||'').trim();
  const gross = kop(c[6]);
  const net = kop(c[7]);
  if (gross <= 0n) { skipped++; continue; }
  const commission = gross - net > 0n ? gross - net : 0n;
  const day = toDate(c[2]); if (!day) { skipped++; continue; }
  const occ = `${day}T12:00:00Z`;
  const goods = (c[13]||'') + ' ' + (c[14]||'');
  const isDone = /выплачен/i.test(status);
  const txStatus = isDone ? 'completed' : 'pending';

  let catId, catName;
  if (isCourse(goods)) { catId=cats['prodamus_course']; catName='course'; course++; }
  else { catId=cats['prodamus_club']; catName='club'; club++; }

  const extInc = `prodamus_${id}`;
  const extComm = `prodamus_comm_${id}`;

  // Идемпотентность: убираем прежние записи этого заказа (старые нетто-июньские тоже).
  await sql`DELETE FROM transactions WHERE external_id IN (${extInc}, ${extComm})`;

  await sql`
    INSERT INTO transactions (
      flow_type, amount, currency, amount_rub, fx_rate,
      entity_id, direction_id, category_id, source_id,
      occurred_at, description, counterparty, pnl_category,
      external_id, created_by, verified, needs_classification, needs_review, needs_owner_review, tx_status
    ) VALUES (
      'income', ${gross}, 'RUB', ${gross}, NULL,
      ${IP}, NULL, ${catId}, ${SRC},
      ${occ}, ${'Продамус'}, ${'Продамус'}, NULL,
      ${extInc}, ${OWNER}, false, false, false, false, ${txStatus}
    )`;
  inc++; grossSum += gross;
  if (isDone) doneGross += gross; else { pendGross += gross; pendNet += net; }

  if (commission > 0n) {
    await sql`
      INSERT INTO transactions (
        flow_type, amount, currency, amount_rub, fx_rate,
        entity_id, direction_id, category_id, source_id,
        occurred_at, description, counterparty, pnl_category,
        external_id, created_by, verified, needs_classification, needs_review, needs_owner_review, tx_status
      ) VALUES (
        'expense', ${commission}, 'RUB', ${commission}, NULL,
        ${IP}, NULL, NULL, ${SRC},
        ${occ}, ${'Комиссия Продамуса'}, ${'Комиссия Продамуса'}, 'payment_commission',
        ${extComm}, ${OWNER}, false, false, false, false, ${txStatus}
      )`;
    comm++; commSum += commission;
  }
}

const r = k => (Number(k)/100).toLocaleString('ru-RU',{minimumFractionDigits:2});
console.log(`Обработано строк: ${lines.length-1}, пропущено: ${skipped}`);
console.log(`Доходов вставлено: ${inc} (курс ${course} / клуб ${club})`);
console.log(`Комиссий вставлено: ${comm}`);
console.log(`\nВаловый доход всего: ${r(grossSum)} ₽`);
console.log(`Комиссия всего:      ${r(commSum)} ₽`);
console.log(`\n── Деньги в пути (не выплачено на ИП) ──`);
console.log(`  валовый: ${r(pendGross)} ₽ | нетто к зачислению: ${r(pendNet)} ₽`);
console.log(`  завершено (выплачено на ИП): ${r(doneGross)} ₽ (валовый)`);
await sql.end();
