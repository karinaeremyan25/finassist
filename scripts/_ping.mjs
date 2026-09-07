import { readFile } from 'node:fs/promises'; import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const url=process.env.DATABASE_URL||'';
console.log('DATABASE_URL host:', (url.match(/@([^:/]+)/)||[])[1] || '?');
const sql = postgres(url, { max: 1, connect_timeout: 8, idle_timeout: 4, max_lifetime: 10 });
const t0=Date.now();
try { const r = await sql`SELECT now() AS t`; console.log('DB OK за', Date.now()-t0,'мс:', r[0].t); }
catch(e){ console.log('DB FAIL за', Date.now()-t0,'мс:', e.code||'', e.message); }
try { await sql.end({timeout:3}); } catch {}
process.exit(0);
