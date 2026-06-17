import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env=await readFile(new URL('../.env',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
const sql=postgres(process.env.DATABASE_URL,{onnotice:()=>{},max:1});
const before=(await sql`SELECT COUNT(*)::int AS c FROM transactions WHERE needs_review=true AND deleted_at IS NULL`)[0].c;
const upd=await sql`UPDATE transactions SET needs_review=false WHERE needs_review=true AND deleted_at IS NULL RETURNING id`;
console.log(JSON.stringify({flaggedBefore:before, cleared:upd.length}));
await sql.end();
