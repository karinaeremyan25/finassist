/**
 * E2E-тест Lava.top вебхука: подпись → вставка → дедуп → маршрутизация юрлиц.
 * Запуск: node scripts/test_lava.mjs   (после npm run build). Чистит за собой.
 */
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import postgres from 'postgres';

const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
process.env.LAVA_WEBHOOK_SECRET = 'test_secret_lava_123';

const { handleLavaWebhook } = await import('../dist/services/integrations/lava.js');
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });

const IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const OOO = 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d';
const SECRET = process.env.LAVA_WEBHOOK_SECRET;
const sign = (b) => crypto.createHmac('sha256', SECRET).update(b, 'utf8').digest('hex');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const ids = [];
const post = async (over) => {
  const cid = 'TEST-lava-' + (over.contractId || Math.abs([...JSON.stringify(over)].reduce((a,c)=>a*31+c.charCodeAt(0)|0,7)));
  const body = JSON.stringify({ eventType:'payment.success', contractId:cid, amount:1000, currency:'RUB', timestamp:'2026-06-17T10:00:00Z', buyer:{email:'x@y.z'}, ...over, contractId:cid });
  ids.push('lava_' + cid);
  // авторизация по «API key» (секрет в произвольном заголовке)
  const res = await handleLavaWebhook(body, { candidates: [SECRET] });
  const row = (await sql`SELECT t.entity_id, c.code AS cat, t.amount_rub FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.external_id=${'lava_'+cid} AND t.deleted_at IS NULL`)[0];
  return { res, row };
};

try {
  // 1. неверная авторизация → 400
  const bad = await handleLavaWebhook('{"eventType":"payment.success","contractId":"x","amount":1,"currency":"RUB"}', { candidates: ['wrong-secret'] });
  ok(bad.status === 400, '1. Неверный секрет → 400');

  // 1b. HMAC-подпись тоже принимается
  const hbody = JSON.stringify({ eventType:'payment.success', contractId:'TEST-lava-hmac', amount:10, currency:'RUB', product:{id:'p',title:'x'} });
  ids.push('lava_TEST-lava-hmac');
  const hres = await handleLavaWebhook(hbody, { signature: sign(hbody) });
  ok(hres.status === 200, '1b. HMAC-подпись → 200');

  // 2. базовая вставка + сумма + приватность
  const base = await post({ contractId:'base', amount:1500.50, product:{id:'p1',title:'Что-то'} });
  ok(base.res.status === 200 && base.row, '2. Валидная подпись → вставка');
  ok(BigInt(base.row?.amount_rub ?? 0) === 150050n, `2a. Сумма 150050 коп (факт ${base.row?.amount_rub})`);

  // 3. дедуп
  const body2 = JSON.stringify({ eventType:'payment.success', contractId:'TEST-lava-base', amount:1500.50, currency:'RUB', product:{id:'p1',title:'Что-то'} });
  await handleLavaWebhook(body2, sign(body2));
  const cnt = (await sql`SELECT count(*)::int n FROM transactions WHERE external_id=${'lava_TEST-lava-base'} AND deleted_at IS NULL`)[0].n;
  ok(cnt === 1, '3. Дедуп — одна транзакция при повторе');

  // 4. РОУТИНГ: курс ДПО → ООО / lava_course
  const dpo = await post({ contractId:'dpo', product:{id:'p-dpo',title:'DPO "Psychology of Health" — Expert (Full Career Package)'} });
  ok(dpo.row?.entity_id === OOO, '4. Курс ДПО Expert → ООО');
  ok(dpo.row?.cat === 'lava_course', '4a. Категория lava_course');

  const dpoBasic = await post({ contractId:'dpobasic', product:{id:'p-dpo2',title:'DPO "Psychology of Health" — Basic'} });
  ok(dpoBasic.row?.entity_id === OOO, '4b. Курс ДПО Basic → ООО');

  // 5. РОУТИНГ: клуб → ИП / lava_club
  const club = await post({ contractId:'club', product:{id:'p-club',title:'Club Metanoia — Monthly Membership'} });
  ok(club.row?.entity_id === IP, '5. Клуб Метанойя → ИП');
  ok(club.row?.cat === 'lava_club', '5a. Категория lava_club');

  // 6. РОУТИНГ: консультация (даже "DPO Program") → ИП / other_income (не курс!)
  const consult = await post({ contractId:'consult', product:{id:'p-cons',title:'Student Consultation — DPO Program'} });
  ok(consult.row?.entity_id === IP, '6. Консультация студента ДПО → ИП (не ООО)');
  ok(consult.row?.cat === 'other_income', '6a. Категория other_income');

  // 7. РОУТИНГ: сопровождение → ИП
  const guid = await post({ contractId:'guid', product:{id:'p-g',title:'Personal Guidance with Karina Eremyan'} });
  ok(guid.row?.entity_id === IP, '7. Сопровождение Карина → ИП');

  // 8. УСПЕХ по статусу (eventType нестандартный) → запись создаётся
  const byStatus = await post({ contractId:'bystatus', eventType:'PaymentResult', status:'completed', product:{id:'p1',title:'Что-то'} });
  ok(byStatus.row, '8. eventType=PaymentResult + status=completed → запись создана');

  // 9. НЕУДАЧА → записи нет
  const failCid = 'TEST-lava-failed';
  ids.push('lava_'+failCid);
  const fbody = JSON.stringify({ eventType:'payment.failed', contractId:failCid, amount:100, currency:'RUB', status:'failed', product:{id:'p1',title:'x'} });
  await handleLavaWebhook(fbody, { candidates:[SECRET] });
  const failRow = (await sql`SELECT id FROM transactions WHERE external_id=${'lava_'+failCid} AND deleted_at IS NULL`);
  ok(failRow.length === 0, '9. payment.failed → транзакция НЕ создана');
} catch (e) {
  fail++; console.log('  ❌ Исключение:', e.message);
} finally {
  const del = await sql`DELETE FROM transactions WHERE external_id = ANY(${ids}) RETURNING id`;
  console.log(`\nОчищено тестовых строк: ${del.length}`);
  console.log(`ИТОГО: ${pass} прошло, ${fail} упало`);
  await sql.end({ timeout: 5 });
  process.exit(fail > 0 ? 1 : 0);
}
