import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env=await readFile(new URL('../.env',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
const TOK=process.env.TOCHKA_JWT_TOKEN, BASE='https://enter.tochka.com/uapi/open-banking/v1.0';
const H={'Authorization':'Bearer '+TOK,'Content-Type':'application/json'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MYINN='231149826704';
const sql=postgres(process.env.DATABASE_URL,{onnotice:()=>{},max:1});
const SRC=(await sql`SELECT id FROM sources WHERE code='tochka'`)[0].id;
const ENTITY='8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const DIR_DPO='b17eb69e-4bd3-441f-8a0c-57734d56840c';
const cats=Object.fromEntries((await sql`SELECT code,id FROM categories`).map(r=>[r.code,r.id]));
const OWNER=BigInt(process.env.OWNER_TG_ID);
const acc=(await (await fetch(BASE+'/accounts',{headers:H})).json()).Data.Account;
const myNums=new Set(acc.map(a=>a.accountId.split('/')[0]));
const isOwn=t=>{const p=(t.creditDebitIndicator==='Credit'?t.DebtorParty:t.CreditorParty)||{};const dest=(t.creditDebitIndicator==='Credit'?t.DebtorAccount:t.CreditorAccount)?.identification||'';return p.inn===MYINN||/собственных средств/i.test(t.description||'')||myNums.has(dest.split('/')[0]);};
const isLoan=name=>/фреш\s*кредит/i.test(name||'');
const del=await sql`DELETE FROM transactions WHERE source_id=${SRC} RETURNING id`;
console.log('удалено прежних tochka:', del.length);
let nInc=0,nExp=0,nLoan=0;
for(const a of acc){
  const id=a.accountId;
  const init=await (await fetch(`${BASE}/statements`,{method:'POST',headers:H,body:JSON.stringify({Data:{Statement:{accountId:id,startDateTime:'2026-01-01',endDateTime:'2026-06-13'}}})})).json();
  const sid=init.Data.Statement.statementId; let txs=null;
  for(let i=0;i<45;i++){const r=await (await fetch(`${BASE}/accounts/${encodeURIComponent(id)}/statements/${sid}`,{headers:H})).json();const st=(Array.isArray(r.Data.Statement)?r.Data.Statement[0]:r.Data.Statement);if(st&&st.status==='Ready'){txs=st.Transaction||[];break;}await sleep(2500);}
  if(txs===null){console.log(id.split('/')[0].slice(-6),'выписка не готова — пропуск');continue;}
  for(const t of txs){
    if(isOwn(t))continue;
    const cr=t.creditDebitIndicator==='Credit';
    const rub=parseFloat(t.Amount?.amount||0); if(!(rub>0))continue;
    const kop=BigInt(Math.round(rub*100));
    const occ=(t.documentProcessDate||'2026-01-01')+'T12:00:00Z';
    const who=((cr?t.DebtorParty?.name:t.CreditorParty?.name)||'').slice(0,200);
    const desc=(t.description||'').slice(0,300);
    const ext='tochka_'+t.transactionId;
    let pnl=null, cat;
    if(cr){ const loan=isLoan(who); if(loan){pnl='loan';nLoan++;} cat=loan?cats['other_income']:(/продамус/i.test(who)?cats['prodamus_course']:(/платежи и расч/i.test(who)?cats['prodamus_club']:cats['other_income'])); }
    else { cat=cats['other_expense']; }
    await sql`INSERT INTO transactions (flow_type,amount,currency,amount_rub,fx_rate,entity_id,direction_id,category_id,source_id,occurred_at,description,counterparty,pnl_category,external_id,created_by,verified,needs_classification,needs_review,needs_owner_review)
      VALUES (${cr?'income':'expense'},${kop},'RUB',${kop},NULL,${ENTITY},${cr?DIR_DPO:null},${cat},${SRC},${occ},${desc},${who},${pnl},${ext},${OWNER},false,${!cr},${!cr},false)
      ON CONFLICT DO NOTHING`;
    if(cr)nInc++;else nExp++;
  }
  console.log(id.split('/')[0].slice(-6),'обработан');
}
console.log(`\nГотово: доходов ${nInc} (из них займов ${nLoan}), расходов ${nExp}`);
await sql.end({timeout:5});
