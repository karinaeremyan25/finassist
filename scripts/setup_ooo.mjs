import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env=await readFile(new URL('../.env',import.meta.url),'utf8');
for(const l of env.split('\n')){const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
const TOK=process.env.TOCHKA_JWT_TOKEN, BASE='https://enter.tochka.com/uapi/open-banking/v1.0';
const H={'Authorization':'Bearer '+TOK,'Content-Type':'application/json'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MYINN='231149826704';
const today=new Date(Date.now()+3*3600e3).toISOString().slice(0,10);
const sql=postgres(process.env.DATABASE_URL,{onnotice:()=>{},max:1});
const SRC=(await sql`SELECT id FROM sources WHERE code='tochka'`)[0].id;
const ENTITY_OOO='ce729bf9-649c-41c5-bbfd-ed0fb785c45d';
const DIR_METANOIA='ac773f21-0f0d-4772-8baf-15cac941c122';
const cats=Object.fromEntries((await sql`SELECT code,id FROM categories`).map(r=>[r.code,r.id]));
const OWNER=BigInt(process.env.OWNER_TG_ID);

// ООО-счета (префикс 40702)
const acc=(await (await fetch(BASE+'/accounts',{headers:H})).json()).Data.Account;
const oooAccts=acc.map(a=>a.accountId).filter(id=>id.split('/')[0].startsWith('40702'));
console.log('ООО-счетов найдено:', oooAccts.length, oooAccts.map(x=>x.split('/')[0].slice(-6)).join(', '));

// для isOwn — все номера счетов (ИП+ООО), внутренние переводы пропускаем
const myNums=new Set(acc.map(a=>a.accountId.split('/')[0]));
const isOwn=t=>{const p=(t.creditDebitIndicator==='Credit'?t.DebtorParty:t.CreditorParty)||{};const dest=(t.creditDebitIndicator==='Credit'?t.DebtorAccount:t.CreditorAccount)?.identification||'';return p.inn===MYINN||/собственных средств/i.test(t.description||'')||myNums.has(dest.split('/')[0]);};
const isLoan=n=>/фреш\s*кредит/i.test(n||'');

// названия/коды фондов для ООО-счетов
const fundMeta={
 '40702810620000238882':{code:'rs_ooo',name:'Расчётный счёт ООО'},
 '40702810920000293475':{code:'ooo_acc2',name:'Счёт ООО (доп.)'},
};

let added=0, fundsUpserted=0;
for(const id of oooAccts){
  const num=id.split('/')[0];
  // баланс
  let kop=0n;
  try{const b=await (await fetch(`${BASE}/accounts/${encodeURIComponent(id)}/balances`,{headers:H})).json();const cl=(b.Data?.Balance||[]).find(x=>x.type==='ClosingAvailable');if(cl)kop=BigInt(Math.round(parseFloat(cl.Amount.amount)*100));}catch(e){console.log('balance err',num.slice(-6),e.message);}
  // upsert фонд-счёт ООО (по tochka_account_id)
  const meta=fundMeta[num]||{code:'ooo_'+num.slice(-6),name:'Счёт ООО '+num.slice(-6)};
  const ex=await sql`SELECT id FROM funds WHERE tochka_account_id=${id}`;
  if(ex.length){
    await sql`UPDATE funds SET balance=${kop}, entity_id=${ENTITY_OOO}, is_active=true, deleted_at=NULL, name=${meta.name}, code=${meta.code} WHERE id=${ex[0].id}`;
  }else{
    await sql`INSERT INTO funds (entity_id,code,name,balance,is_active,tochka_account_id,distribution_percent) VALUES (${ENTITY_OOO},${meta.code},${meta.name},${kop},true,${id},0)`;
  }
  fundsUpserted++;
  console.log(`фонд ${meta.code} (${num.slice(-6)}): ${(Number(kop)/100).toLocaleString('ru')} ₽`);

  // выписка с 1 июня
  const init=await (await fetch(`${BASE}/statements`,{method:'POST',headers:H,body:JSON.stringify({Data:{Statement:{accountId:id,startDateTime:'2026-06-01',endDateTime:today}}})})).json();
  const sid=init.Data.Statement.statementId; let txs=null;
  for(let i=0;i<45;i++){const r=await (await fetch(`${BASE}/accounts/${encodeURIComponent(id)}/statements/${sid}`,{headers:H})).json();const st=(Array.isArray(r.Data.Statement)?r.Data.Statement[0]:r.Data.Statement);if(st&&st.status==='Ready'){txs=st.Transaction||[];break;}await sleep(2500);}
  if(txs===null){console.log(num.slice(-6),'выписка не готова');continue;}
  let accAdded=0;
  for(const t of txs){
    if(isOwn(t))continue;
    const cr=t.creditDebitIndicator==='Credit';
    const rub=parseFloat(t.Amount?.amount||0); if(!(rub>0))continue;
    const kp=BigInt(Math.round(rub*100));
    const occ=(t.documentProcessDate||today)+'T12:00:00Z';
    const who=((cr?t.DebtorParty?.name:t.CreditorParty?.name)||'').slice(0,200);
    const desc=(t.description||'').slice(0,300);
    let pnl=null,cat;
    if(cr){const loan=isLoan(who);if(loan)pnl='loan';cat=loan?cats['other_income']:(/продамус/i.test(who)?cats['prodamus_course']:(/платежи и расч/i.test(who)?cats['prodamus_club']:cats['other_income']));}
    else cat=cats['other_expense'];
    const res=await sql`INSERT INTO transactions (flow_type,amount,currency,amount_rub,fx_rate,entity_id,direction_id,category_id,source_id,occurred_at,description,counterparty,pnl_category,external_id,created_by,verified,needs_classification,needs_review,needs_owner_review)
      VALUES (${cr?'income':'expense'},${kp},'RUB',${kp},NULL,${ENTITY_OOO},${cr?DIR_METANOIA:null},${cat},${SRC},${occ},${desc},${who},${pnl},${'tochka_'+t.transactionId},${OWNER},false,${!cr},${!cr},false)
      ON CONFLICT DO NOTHING RETURNING id`;
    if(res.length){added++;accAdded++;}
  }
  console.log(`  операций добавлено по счёту ${num.slice(-6)}: ${accAdded}`);
}
console.log(`\nИТОГО: фондов-счетов ООО ${fundsUpserted}, новых операций ${added}`);
await sql.end({timeout:5});
