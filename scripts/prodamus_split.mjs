import { readFile } from 'node:fs/promises';
const raw = await readFile('/Users/karinaeremyan/Downloads/paylist (062026).csv'); // буфер
const text = raw.toString('utf8').replace(/^﻿/, '');
const lines = text.split(/\r?\n/).filter(l => l.trim().length);
const header = lines[0].split(';');
const idx = (name) => header.findIndex(h => h.includes(name));
const iDate = idx('Дата');
const iStatus = idx('Статус');
const iCalc = header.findIndex(h => h === 'Расчетная'); // нетто, что зачисляется
const iSum = header.findIndex(h => h === 'Сумма');
const iGoods = idx('Список товаров');
const iAddt = idx('Дополнительные данные');

const num = (s) => Number(String(s ?? '').replace(/\s/g,'').replace(',', '.')) || 0;
// надёжный разбор CSV-строки с кавычками
function parseLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===';'&&!q){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}

const isDpo = (txt) => /курс/i.test(txt) && /психолог/i.test(txt); // курс «Психология здоровья» = ДПО → ООО
const isClub = (txt) => /клуб|метано/i.test(txt);

let dpoSum=0, clubSum=0, otherSum=0, dpoN=0, clubN=0, otherN=0, skipped=0;
let dpoGross=0, clubGross=0;
const byDayClub={}, byDayDpo={};
let totalCalc=0, totalGross=0;
for(let i=1;i<lines.length;i++){
  const c = parseLine(lines[i]);
  const status = c[iStatus]||'';
  if(!/Получен|Обработан/i.test(status)){skipped++; continue;} // только успешные
  const goods = (c[iGoods]||'') + ' ' + (c[iAddt]||'');
  const calc = num(c[iCalc]);
  const gross = num(c[iSum]);
  totalCalc += calc; totalGross += gross;
  const day = (c[iDate]||'').slice(0,10);
  if(isDpo(goods)){dpoSum+=calc;dpoGross+=gross;dpoN++;byDayDpo[day]=(byDayDpo[day]||0)+calc;}
  else if(isClub(goods)){clubSum+=calc;clubGross+=gross;clubN++;byDayClub[day]=(byDayClub[day]||0)+calc;}
  else {otherSum+=calc;otherN++;}
}
const f=n=>n.toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2});
console.log('Всего успешных строк (Расчетная, нетто):', f(totalCalc), '| пропущено невыполненных:', skipped);
console.log('\n=== РАЗБИВКА ПО ПРОДУКТУ (нетто, «Расчетная») ===');
console.log(`ДПО (курс Психология здоровья) → ООО:  нетто ${f(dpoSum)} | грязными ${f(dpoGross)} ₽   (${dpoN} продаж)`);
console.log(`Клуб (Метанойя/клуб Карины)    → ИП :  нетто ${f(clubSum)} | грязными ${f(clubGross)} ₽   (${clubN} продаж)`);
console.log(`ИТОГО грязными: ${f(totalGross)}`);
if(otherN) console.log(`Прочее (не распознано)             :  ${f(otherSum)} ₽   (${otherN})`);
console.log('\nБухгалтер ИП: 845 868 | ООО (ДПО): ?');
console.log('\n=== Клуб (ИП) по дням ===');
for(const d of Object.keys(byDayClub).sort()) console.log(`  ${d}  ${f(byDayClub[d])}`);
console.log('\n=== ДПО (ООО) по дням ===');
for(const d of Object.keys(byDayDpo).sort()) console.log(`  ${d}  ${f(byDayDpo[d])}`);
