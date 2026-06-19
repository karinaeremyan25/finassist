import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });
const IP = '8355ee9e-11ed-4e73-8bcd-2dc0ff3c8068';
const OOO = 'ce729bf9-649c-41c5-bbfd-ed0fb785c45d';

// 1) Юрлицо фонда = по префиксу счёта (40802=ИП, 40702=ООО). Чинит «не сходится».
const fixIp = await sql`UPDATE funds SET entity_id=${IP} WHERE tochka_account_id LIKE ${'40802%'} AND entity_id<>${IP} RETURNING code`;
const fixOoo = await sql`UPDATE funds SET entity_id=${OOO} WHERE tochka_account_id LIKE ${'40702%'} AND entity_id<>${OOO} RETURNING code`;
console.log('Юрлицо поправлено: ИП', fixIp.map(r=>r.code).join(','), '| ООО', fixOoo.map(r=>r.code).join(','));

// 2) Переименование по списку владельца.
const names = {
  rs_ooo: 'Расчётный счёт ООО',
  ooo_acc2: 'Фонд «Налоги ООО»',
  rs_ip: 'Расчётный счёт ИП Еремян',
  gratitude: 'Фонд «Благодарность»',
  credit: 'Фонд «Кредиты»',
  reserve_ip: 'Фонд «Резерв»',
  land: 'Фонд «Земля»',
  tax_ip: 'Фонд «Налог»',
};
for (const [code, name] of Object.entries(names)) {
  await sql`UPDATE funds SET name=${name} WHERE code=${code} AND deleted_at IS NULL`;
}
console.log('Переименовано:', Object.keys(names).length, 'фондов');

console.log('\n=== как теперь (активные) ===');
const f=k=>(Number(k)/100).toLocaleString('ru');
for (const r of await sql`SELECT code,name,balance,(entity_id=${IP}) ip FROM funds WHERE deleted_at IS NULL ORDER BY code`)
  console.log(`${r.ip?'ИП ':'ООО'} ${String(r.code).padEnd(12)} ${f(r.balance).padStart(12)} ₽  «${r.name}»`);
await sql.end();
