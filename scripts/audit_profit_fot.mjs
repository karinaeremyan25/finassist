import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });
const IP='8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068', OOO='ce729bf9-649c-41c5-bbfd-ed0fb785c45d';
const F='2026-06-01', T='2026-07-01';
const f=k=>(Number(k)/100).toLocaleString('ru');
const q=async(e,ft,extra=sql``)=>(await sql`SELECT COALESCE(SUM(amount_rub),0)::bigint s FROM transactions WHERE deleted_at IS NULL AND entity_id=${e} AND flow_type=${ft} AND occurred_at>=${F} AND occurred_at<${T} ${extra}`)[0].s;

for(const [n,e] of [['ИП',IP],['ООО',OOO]]){
  const inc=await q(e,'income');
  const incNoLoan=await q(e,'income',sql`AND pnl_category IS DISTINCT FROM 'loan'`);
  const exp=await q(e,'expense');
  console.log(`\n${n}: доход ${f(inc)} (без займов ${f(incNoLoan)}) | расход ${f(exp)} | доход−расход ${f(BigInt(inc)-BigInt(exp))}`);
}
const allInc=BigInt(await q(IP,'income'))+BigInt(await q(OOO,'income'));
const allExp=BigInt(await q(IP,'expense'))+BigInt(await q(OOO,'expense'));
console.log(`\nСВОДНО: доход ${f(allInc)} | расход ${f(allExp)} | доход−расход ${f(allInc-allExp)}`);

console.log('\n=== расход по pnl_category (июнь, оба юрлица) ===');
for(const r of await sql`SELECT COALESCE(pnl_category,'-') cat, COUNT(*)::int n, SUM(amount_rub)::bigint s FROM transactions WHERE deleted_at IS NULL AND flow_type='expense' AND occurred_at>=${F} AND occurred_at<${T} GROUP BY 1 ORDER BY s DESC`)
  console.log(`  ${r.cat.padEnd(16)} ×${r.n}  ${f(r.s)}`);

console.log('\n=== поиск Сунчелеевой/Суншелеевой среди расходов (июнь) ===');
const sun=await sql`SELECT occurred_at::date d, amount_rub, COALESCE(pnl_category,'-') cat, counterparty, description FROM transactions WHERE deleted_at IS NULL AND flow_type='expense' AND occurred_at>=${F} AND occurred_at<${T} AND (counterparty ILIKE ${'%унчелеев%'} OR counterparty ILIKE ${'%уншелеев%'} OR description ILIKE ${'%унчелеев%'} OR description ILIKE ${'%уншелеев%'}) ORDER BY occurred_at`;
for(const r of sun) console.log(`  ${r.d.toISOString().slice(0,10)} ${f(r.amount_rub)} [${r.cat}] ${String(r.counterparty||r.description).slice(0,50)}`);
console.log('  найдено:', sun.length, '| сумма:', f(sun.reduce((a,r)=>a+Number(r.amount_rub),0)));
await sql.end();
