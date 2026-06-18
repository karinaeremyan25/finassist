import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });
const f = k => (Number(k)/100).toLocaleString('ru');

console.log('=== доход за июнь по источникам (source.code) ===');
for (const r of await sql`
  SELECT s.code src, COUNT(*)::int n, SUM(t.amount_rub)::bigint sum
  FROM transactions t JOIN sources s ON s.id=t.source_id
  WHERE t.deleted_at IS NULL AND t.flow_type='income'
    AND t.occurred_at>='2026-06-01' AND t.occurred_at<'2026-07-01'
  GROUP BY 1 ORDER BY sum DESC`) console.log(`  ${String(r.src).padEnd(12)} ×${r.n}  ${f(r.sum)} ₽`);

console.log('\n=== таблицы про prodamus mapping ===');
const tbls = await sql`SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%prodamus%' OR table_name ILIKE '%product_map%' OR table_name ILIKE '%mapping%'`;
console.log('  ', tbls.map(t=>t.table_name).join(', ') || '(нет)');

for (const t of tbls) {
  const name = t.table_name;
  const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name=${name} ORDER BY ordinal_position`).map(c=>c.column_name);
  console.log(`\n--- ${name} (${cols.join(', ')}) ---`);
  const rows = await sql`SELECT * FROM ${sql(name)} LIMIT 50`;
  console.log('  строк:', rows.length);
  for (const r of rows) console.log('  ', JSON.stringify(r).slice(0,200));
}
await sql.end();
