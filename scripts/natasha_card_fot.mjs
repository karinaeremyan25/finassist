import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const TOK=process.env.TOCHKA_JWT_TOKEN, BASE='https://enter.tochka.com/uapi/open-banking/v1.0';
const H={Authorization:'Bearer '+TOK,'Content-Type':'application/json'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sql=postgres(process.env.DATABASE_URL,{onnotice:()=>{},max:1});
const f=k=>(Number(k)/100).toLocaleString('ru');
const DOP='40802810420000644796/044525104'; // Счёт ИП (доп) = карта Наташи Скрипниковой
const today=new Date(Date.now()+3*3600e3).toISOString().slice(0,10);

// 1. выписка доп-карты с 1 июня → собрать transactionId всех ДЕБЕТовых операций (траты)
const init=await (await fetch(`${BASE}/statements`,{method:'POST',headers:H,body:JSON.stringify({Data:{Statement:{accountId:DOP,startDateTime:'2026-06-01',endDateTime:today}}})})).json();
const sid=init.Data.Statement.statementId; let txs=null;
for(let i=0;i<45;i++){const r=await (await fetch(`${BASE}/accounts/${encodeURIComponent(DOP)}/statements/${sid}`,{headers:H})).json();const st=Array.isArray(r.Data.Statement)?r.Data.Statement[0]:r.Data.Statement;if(st&&st.status==='Ready'){txs=st.Transaction||[];break;}await sleep(2500);}
if(txs===null){console.log('выписка доп-карты не готова');process.exit(1);}
const debitIds=txs.filter(t=>t.creditDebitIndicator==='Debit').map(t=>'tochka_'+t.transactionId);
console.log('дебетовых операций на доп-карте (траты):', debitIds.length);

// 2. перевести их в ФОТ Наташи (без жёлтого), пометить как зарплатные траты
const upd=await sql`UPDATE transactions
  SET pnl_category=${'payroll'}, is_personal=false, needs_review=false, needs_classification=false,
      counterparty=${'Наташа Скрипникова (ЗП)'},
      description = ${'Наташа Скрипникова (ЗП)'} || CASE WHEN description IS NULL OR description='' THEN '' ELSE ' · ' || description END
  WHERE deleted_at IS NULL AND flow_type=${'expense'} AND external_id = ANY(${debitIds})
  RETURNING amount_rub`;
console.log('переведено трат доп-карты в ФОТ Наташи:', upd.length, 'на сумму', f(upd.reduce((a,r)=>a+Number(r.amount_rub),0)));

// 3. скрыть доп-счёт из «Денег на ИП» и списка фондов (soft-delete фонда)
const balRow=await sql`SELECT balance FROM funds WHERE code=${'ip_acc2'} AND deleted_at IS NULL`;
const bal=balRow[0]?.balance ?? 0n;
await sql`UPDATE funds SET deleted_at=NOW() WHERE code=${'ip_acc2'} AND deleted_at IS NULL`;
console.log('доп-счёт скрыт из фондов. Его баланс (часть ФОТ):', f(bal), '₽');

// 4. ФОТ за июнь теперь
const fot=await sql`SELECT COALESCE(SUM(amount_rub),0)::bigint s FROM transactions WHERE deleted_at IS NULL AND flow_type=${'expense'} AND pnl_category=${'payroll'} AND occurred_at>=${'2026-06-01'} AND occurred_at<${'2026-07-01'}`;
console.log('ФОТ (payroll) июнь теперь:', f(fot[0].s), '₽');
await sql.end();
