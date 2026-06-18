import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });
const IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const f = k => (Number(k)/100).toLocaleString('ru');
const FROM = '2026-06-01', TO = '2026-07-01';

const tot = (await sql`SELECT COALESCE(SUM(amount_rub),0)::bigint t, COUNT(*)::int n FROM transactions WHERE deleted_at IS NULL AND entity_id=${IP} AND flow_type='income' AND occurred_at>=${FROM} AND occurred_at<${TO}`)[0];
console.log(`ИП доход июнь (наше приложение): ${f(tot.t)} ₽  (${tot.n} операций)`);
console.log(`Бухгалтер по ИП: 845 868 ₽\n`);

console.log('=== ВСЕ операции дохода ИП за июнь (по дате) ===');
const rows = await sql`SELECT occurred_at::date d, amount_rub, COALESCE(pnl_category,'-') cat, COALESCE(counterparty,'(пусто)') c, COALESCE(external_id,'') ext, source_id FROM transactions WHERE deleted_at IS NULL AND entity_id=${IP} AND flow_type='income' AND occurred_at>=${FROM} AND occurred_at<${TO} ORDER BY occurred_at`;
for (const r of rows) console.log(`${r.d.toISOString().slice(0,10)}  ${f(r.amount_rub).padStart(12)} ₽  [${r.cat}]  ${String(r.c).slice(0,40)}  ${r.ext.slice(0,20)}`);

console.log('\n=== по категории ===');
for (const r of await sql`SELECT COALESCE(pnl_category,'-') cat, COUNT(*)::int n, SUM(amount_rub)::bigint s FROM transactions WHERE deleted_at IS NULL AND entity_id=${IP} AND flow_type='income' AND occurred_at>=${FROM} AND occurred_at<${TO} GROUP BY 1 ORDER BY s DESC`) console.log(`  ${r.cat.padEnd(14)} ×${r.n}  ${f(r.s)} ₽`);

console.log('\n=== признак тестовых/lava записей ===');
for (const r of await sql`SELECT external_id, amount_rub, occurred_at::date d FROM transactions WHERE deleted_at IS NULL AND entity_id=${IP} AND flow_type='income' AND (external_id ILIKE 'lava_%' OR external_id ILIKE '%SIM%' OR external_id ILIKE '%TEST%') ORDER BY occurred_at`) console.log(`  ${r.external_id} ${f(r.amount_rub)} ₽ ${r.d.toISOString().slice(0,10)}`);
await sql.end();
