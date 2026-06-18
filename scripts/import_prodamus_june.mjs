import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });

const IP='8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068', OOO='ce729bf9-649c-41c5-bbfd-ed0fb785c45d';
const SRC=(await sql`SELECT id FROM sources WHERE code='prodamus'`)[0].id;
const cats=Object.fromEntries((await sql`SELECT code,id FROM categories WHERE code IN ('prodamus_course','prodamus_club')`).map(r=>[r.code,r.id]));
const OWNER=BigInt(process.env.OWNER_TG_ID);

const text=(await readFile('/Users/karinaeremyan/Downloads/paylist (062026).csv')).toString('utf8').replace(/^﻿/,'');
const lines=text.split(/\r?\n/).filter(l=>l.trim().length);
const header=lines[0].split(';');
const iId=0, iDate=header.findIndex(h=>h==='Дата'), iStatus=header.findIndex(h=>h==='Статус');
const iCalc=header.findIndex(h=>h==='Расчетная'), iGoods=header.findIndex(h=>h.includes('Список товаров')), iAddt=header.findIndex(h=>h.includes('Дополнительные данные'));
function parseLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===';'&&!q){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}
const num=s=>Number(String(s??'').replace(/\s/g,'').replace(',','.'))||0;
const isDpo=t=>/курс/i.test(t)&&/психолог/i.test(t);
const isClub=t=>/клуб|метано/i.test(t);
const toDate=s=>{const m=/^(\d{2})\.(\d{2})\.(\d{4})/.exec(s||'');return m?`${m[3]}-${m[2]}-${m[1]}`:null;};

let added=0, dpo=0, club=0, skipped=0, unknown=0;
for(let i=1;i<lines.length;i++){
  const c=parseLine(lines[i]);
  if(!/Получен|Обработан/i.test(c[iStatus]||'')){skipped++;continue;}
  const goods=(c[iGoods]||'')+' '+(c[iAddt]||'');
  const kopRub=Math.round(num(c[iCalc])*100); if(!(kopRub>0))continue;
  const kop=BigInt(kopRub);
  const day=toDate(c[iDate]); if(!day)continue;
  const occ=`${day}T12:00:00Z`;
  let entity,catId,catName;
  if(isDpo(goods)){entity=OOO;catId=cats['prodamus_course'];catName='ДПО→ООО';}
  else if(isClub(goods)){entity=IP;catId=cats['prodamus_club'];catName='клуб→ИП';}
  else {unknown++; entity=IP;catId=cats['prodamus_club'];catName='?→ИП';}
  const ext='prodamus_'+(c[iId]||'').trim();
  const res=await sql`INSERT INTO transactions (flow_type,amount,currency,amount_rub,fx_rate,entity_id,direction_id,category_id,source_id,occurred_at,description,counterparty,pnl_category,external_id,created_by,verified,needs_classification,needs_review,needs_owner_review)
    VALUES (${'income'},${kop},'RUB',${kop},NULL,${entity},NULL,${catId},${SRC},${occ},${'Продамус'},${'ООО ПРОДАМУС'},${'income'},${ext},${OWNER},false,false,false,false)
    ON CONFLICT DO NOTHING RETURNING id`;
  if(res.length){added++; if(catName.includes('ДПО'))dpo++; else club++;}
}
console.log(`Импортировано продаж Продамуса: ${added} (ДПО→ООО: ${dpo}, клуб→ИП: ${club}, не распознано: ${unknown}), пропущено: ${skipped}`);

// снимаем банковские Продамус-зачисления на ИП за июнь (чтобы не задваивать)
const del=await sql`UPDATE transactions SET deleted_at=NOW()
  WHERE deleted_at IS NULL AND entity_id=${IP} AND flow_type='income'
    AND counterparty ILIKE ${'%ПРОДАМУС%'} AND external_id ILIKE ${'tochka_%'}
    AND occurred_at>='2026-06-01' AND occurred_at<'2026-07-01' RETURNING id`;
console.log(`Снято банковских Продамус-зачислений (ИП): ${del.length}`);

const f=k=>(Number(k)/100).toLocaleString('ru');
for(const [n,e] of [['ИП',IP],['ООО',OOO]]){
  const t=(await sql`SELECT COALESCE(SUM(amount_rub),0)::bigint s FROM transactions WHERE deleted_at IS NULL AND entity_id=${e} AND flow_type='income' AND occurred_at>='2026-06-01' AND occurred_at<'2026-07-01'`)[0].s;
  console.log(`${n} доход июнь теперь: ${f(t)} ₽`);
}
await sql.end();
