/**
 * E2E-тест Lava.top вебхука: подпись → вставка → дедуп. Чистит за собой.
 * Запуск: node scripts/test_lava.mjs   (после npm run build)
 */
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import postgres from 'postgres';

const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
// тестовый секрет (config читает из env при импорте)
process.env.LAVA_WEBHOOK_SECRET = 'test_secret_lava_123';

const { handleLavaWebhook } = await import('../dist/services/integrations/lava.js');
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });

const TEST_CONTRACT = 'TEST-' + 'e2e-lava-001';
const externalId = `lava_${TEST_CONTRACT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

const sign = (body) => crypto.createHmac('sha256', process.env.LAVA_WEBHOOK_SECRET).update(body, 'utf8').digest('hex');
const payload = {
  eventType: 'payment.success',
  contractId: TEST_CONTRACT,
  product: { id: 'TEST_OFFER', title: 'Тестовый продукт' },
  amount: 1500.50,
  currency: 'RUB',
  status: 'completed',
  timestamp: '2026-06-17T10:00:00Z',
  buyer: { email: 'secret@example.com' },
};
const body = JSON.stringify(payload);

try {
  // 0. чистим возможный артефакт прошлого прогона
  await sql`DELETE FROM transactions WHERE external_id = ${externalId}`;

  // 1. плохая подпись → 400
  const bad = await handleLavaWebhook(body, 'deadbeef');
  ok(bad.status === 400 && !bad.ok, '1. Плохая подпись → 400 bad sign');

  // 2. валидная подпись → 200, транзакция вставлена
  const good = await handleLavaWebhook(body, sign(body));
  ok(good.status === 200 && good.ok, '2. Валидная подпись → 200 ok');
  const rows = await sql`SELECT amount_rub, currency, flow_type, external_id, pnl_category, description, raw_ai_response FROM transactions WHERE external_id = ${externalId} AND deleted_at IS NULL`;
  ok(rows.length === 1, '2a. Ровно одна транзакция создана');
  ok(BigInt(rows[0]?.amount_rub ?? 0) === 150050n, `2b. Сумма = 150050 коп (1500.50 ₽), факт ${rows[0]?.amount_rub}`);
  ok(rows[0]?.flow_type === 'income', '2c. flow_type = income');
  const raw = rows[0]?.raw_ai_response;
  const rawStr = JSON.stringify(raw ?? {});
  ok(!rawStr.includes('secret@example.com'), '2d. Email покупателя НЕ сохранён (приватность)');

  // 3. повторный вебхук → дедуп, дубля нет
  const dup = await handleLavaWebhook(body, sign(body));
  ok(dup.status === 200, '3. Повтор → 200');
  const rows2 = await sql`SELECT id FROM transactions WHERE external_id = ${externalId} AND deleted_at IS NULL`;
  ok(rows2.length === 1, '3a. Дедуп работает — всё ещё одна транзакция');

  // 4. неуспешное событие → пропуск
  const cancel = await handleLavaWebhook(JSON.stringify({ ...payload, eventType: 'subscription.cancelled', contractId: TEST_CONTRACT + '-cancel' }), sign(JSON.stringify({ ...payload, eventType: 'subscription.cancelled', contractId: TEST_CONTRACT + '-cancel' })));
  ok(cancel.status === 200, '4. Событие cancelled → 200 (пропущено)');
  const rowsC = await sql`SELECT id FROM transactions WHERE external_id = ${'lava_' + TEST_CONTRACT + '-cancel'}`;
  ok(rowsC.length === 0, '4a. Для cancelled транзакция НЕ создана');
} catch (e) {
  fail++; console.log('  ❌ Исключение:', e.message);
} finally {
  // чистим тестовые артефакты (hard delete — это тестовые данные)
  const del = await sql`DELETE FROM transactions WHERE external_id IN (${externalId}, ${'lava_' + TEST_CONTRACT + '-cancel'}) RETURNING id`;
  console.log(`\nОчищено тестовых строк: ${del.length}`);
  console.log(`ИТОГО: ${pass} прошло, ${fail} упало`);
  await sql.end({ timeout: 5 });
  process.exit(fail > 0 ? 1 : 0);
}
