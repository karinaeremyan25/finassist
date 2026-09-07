import { readFile } from 'node:fs/promises'; import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });
console.log('=== последние отметки отправки отчёта (alert_log daily_report) ===');
for(const x of await sql`SELECT type, created_at FROM alert_log WHERE type LIKE 'daily_report:%' ORDER BY created_at DESC LIMIT 8`) console.log(`  ${x.type} | ${x.created_at}`);
console.log('\n=== последний синк Точки (свежие операции/создание) ===');
const t=(await sql`SELECT MAX(occurred_at) mo, MAX(created_at) mc FROM transactions WHERE deleted_at IS NULL AND source_id=(SELECT id FROM sources WHERE code='tochka')`)[0];
console.log('  последняя операция Точки occurred:', t.mo, '| создана:', t.mc);
console.log('\n=== баланс фондов: когда обновлялся ===');
for(const x of await sql`SELECT code, updated_at FROM funds WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 3`) console.log(`  ${x.code} | ${x.updated_at}`);
console.log('\n=== любой синк/приход за последние 3 дня? ===');
const rec=(await sql`SELECT COUNT(*) n, MAX(created_at) m FROM transactions WHERE created_at>=NOW()-INTERVAL '3 days'`)[0];
console.log('  создано операций за 3 дня:', rec.n, '| последняя:', rec.m);
await sql.end();
