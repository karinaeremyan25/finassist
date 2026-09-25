import { readFile } from 'node:fs/promises'; import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { max:1, connect_timeout:12, idle_timeout:5 });
const r=v=>Number(v).toLocaleString('ru-RU');
try{
  const n=(await sql`SELECT COUNT(*) c FROM transactions WHERE deleted_at IS NULL AND flow_type='expense' AND description ~ '7820' AND occurred_at>=NOW()-INTERVAL '30 days'`)[0].c;
  console.log('операций по …7820 за 30 дней:', n);
  console.log('\n=== примеры (последние 25) ===');
  for(const x of await sql`SELECT to_char(occurred_at,'MM-DD') d, amount_rub a, pnl_category c, is_personal p, LEFT(COALESCE(description,''),70) ds FROM transactions WHERE deleted_at IS NULL AND flow_type='expense' AND description ~ '7820' AND occurred_at>=NOW()-INTERVAL '30 days' ORDER BY occurred_at DESC LIMIT 25`)
    console.log(`  ${x.d} | ${String(r(Number(x.a)/100)).padStart(9)} | ${x.c||'—'} | pers=${x.p} | ${x.ds}`);
}catch(e){ console.log('DB ERR:', e.code||'', e.message); }
try{ await sql.end({timeout:3}); }catch{}
process.exit(0);
