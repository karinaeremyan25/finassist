/**
 * Бэкфилл комиссии эквайринга для уже загруженных приходов Точки.
 *
 * Приходные зачисления по терминалу содержат в назначении СПРАВОЧНО удержанную
 * комиссию («…Справочно: сумма комиссии 1579.9 руб.…»). Раньше доход писался
 * НЕТТО (как пришло на счёт), комиссия терялась. Приводим к модели Продамуса:
 *   income → ВАЛОВЫЙ (нетто + комиссия), плюс отдельный расход payment_commission.
 *
 * Идемпотентно: обрабатываем только те приходы, у которых ещё НЕТ парного
 * расхода external_id = '<ext>_comm'. Повторный запуск ничего не задваивает.
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) { const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim(); }
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });
const OWNER = BigInt(process.env.OWNER_TG_ID);
const RE = /Справочно:\s*сумма комиссии\s*(\d+(?:[.,]\d+)?)\s*руб/i;

const rows = await sql`
  SELECT id, entity_id, source_id, occurred_at, amount_rub, external_id, description
  FROM transactions
  WHERE flow_type='income' AND deleted_at IS NULL
    AND description ~* 'Справочно: сумма комиссии'
  ORDER BY occurred_at`;

let grossedUp = 0, commAdded = 0, skipped = 0, totalComm = 0n;
for (const r of rows) {
  const m = RE.exec(r.description || '');
  if (!m) { skipped++; continue; }
  const cRub = Number(m[1].replace(',', '.'));
  if (!(cRub > 0)) { skipped++; continue; }
  const commKop = BigInt(Math.round(cRub * 100));
  const commExt = `${r.external_id}_comm`;

  // Идемпотентность: если парный расход уже есть — этот приход уже обработан.
  const exists = await sql`SELECT 1 FROM transactions WHERE external_id=${commExt} AND deleted_at IS NULL LIMIT 1`;
  if (exists.length) { skipped++; continue; }

  const netKop = BigInt(r.amount_rub);
  const grossKop = netKop + commKop;

  await sql`UPDATE transactions SET amount=${grossKop}, amount_rub=${grossKop}, updated_at=NOW() WHERE id=${r.id}`;
  grossedUp++;

  await sql`
    INSERT INTO transactions (
      flow_type, amount, currency, amount_rub, fx_rate,
      entity_id, direction_id, category_id, source_id,
      occurred_at, description, counterparty, pnl_category,
      external_id, created_by,
      verified, needs_classification, needs_review, needs_owner_review
    ) VALUES (
      'expense', ${commKop}, 'RUB', ${commKop}, NULL,
      ${r.entity_id}, NULL, NULL, ${r.source_id},
      ${r.occurred_at}, ${'Комиссия эквайринга (Точка)'}, ${'Комиссия эквайринга Точки'}, 'payment_commission',
      ${commExt}, ${OWNER},
      false, false, false, false
    )
    ON CONFLICT (external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL DO NOTHING`;
  commAdded++;
  totalComm += commKop;
  console.log(`  ${String(r.occurred_at).slice(0,10)}: нетто ${(Number(netKop)/100).toFixed(2)} + комиссия ${cRub} → валовый ${(Number(grossKop)/100).toFixed(2)}`);
}

console.log(`\nИтог: приходов найдено ${rows.length}, доход поднят до валового ${grossedUp}, добавлено расходов-комиссий ${commAdded}, пропущено (уже сделано) ${skipped}`);
console.log(`Сумма комиссии эквайринга всего: ${(Number(totalComm)/100).toFixed(2)} ₽`);
await sql.end();
