import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });
const IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const f = k => (Number(k)/100).toLocaleString('ru');

console.log('=== ВСЕ фонды/счета в базе ===');
const rows = await sql`SELECT code,name,balance,tochka_account_id,is_active,deleted_at,entity_id FROM funds ORDER BY deleted_at NULLS FIRST, tochka_account_id`;
for (const r of rows) {
  const ip = r.entity_id === IP ? 'ИП ' : 'ООО';
  console.log(`${r.deleted_at?'[СКРЫТ] ':'        '}${ip} ${String(r.code).padEnd(13)} ${f(r.balance).padStart(12)} ₽  ${(r.tochka_account_id||'(нет)').split('/')[0]}  «${r.name}»`);
}

const TOK=process.env.TOCHKA_JWT_TOKEN, BASE='https://enter.tochka.com/uapi/open-banking/v1.0', H={Authorization:'Bearer '+TOK};
const acc=(await (await fetch(BASE+'/accounts',{headers:H})).json()).Data.Account;
console.log('\n=== живые остатки Точки ===');
let ipSum=0, oooSum=0;
for (const a of acc) {
  try {
    const b=await (await fetch(`${BASE}/accounts/${encodeURIComponent(a.accountId)}/balances`,{headers:H})).json();
    const cl=(b.Data?.Balance||[]).find(x=>x.type==='ClosingAvailable');
    const num=a.accountId.split('/')[0];
    const amt=cl?Number(cl.Amount.amount):0;
    if(num.startsWith('40802')) ipSum+=amt; if(num.startsWith('40702')) oooSum+=amt;
    console.log(`${num.startsWith('40702')?'ООО':'ИП '} ${num}  ${amt.toLocaleString('ru')} ₽`);
  } catch(e){ console.log(a.accountId,'err'); }
}
console.log(`\nИТОГО живые: ИП(40802) ${ipSum.toLocaleString('ru')} | ООО(40702) ${oooSum.toLocaleString('ru')}`);
await sql.end();
