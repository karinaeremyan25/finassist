/**
 * Пакетная классификация расходных транзакций для P&L.
 *
 * Берёт все расходы с pnl_category IS NULL AND deleted_at IS NULL,
 * прогоняет через classifyTransactions (батчи по ~20 → Claude),
 * проставляет pnl_category / is_personal / classifier_confidence / needs_review.
 *
 * Перед запуском: npm run build (импортируем из dist/).
 * Идемпотентно: повторный запуск берёт только ещё не классифицированные.
 *
 * Запуск:  node scripts/classify_transactions.mjs
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

// --- загрузка .env (как в других скриптах проекта) ---
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
for (const l of env.split('\n')) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { classifyTransactions } = await import('../dist/services/transactionClassifier.js');

const CONFIDENCE_THRESHOLD = 0.7;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {}, max: 1 });

const rows = await sql`
  SELECT id, counterparty, amount_rub, description, flow_type
  FROM transactions
  WHERE flow_type = 'expense'
    AND pnl_category IS NULL
    AND deleted_at IS NULL
`;

console.log(`К классификации: ${rows.length} расходных транзакций`);
if (rows.length === 0) {
  await sql.end({ timeout: 5 });
  process.exit(0);
}

// amount_rub — копейки (bigint). Для модели передаём отрицательную сумму в рублях (расход).
const txs = rows.map((r) => ({
  id: r.id,
  counterparty: r.counterparty,
  amount: -Math.abs(Number(r.amount_rub) / 100),
  description: r.description,
  inn: null,
  flowType: r.flow_type,
}));

const results = await classifyTransactions(txs);

let updated = 0;
let needsReview = 0;
const byCategory = {};

for (const c of results) {
  const review = c.confidence < CONFIDENCE_THRESHOLD;
  await sql`
    UPDATE transactions
    SET pnl_category = ${c.pnlCategory},
        is_personal = ${c.isPersonal},
        classifier_confidence = ${c.confidence},
        needs_review = ${review}
    WHERE id = ${c.id}
  `;
  updated++;
  if (review) needsReview++;
  byCategory[c.pnlCategory] = (byCategory[c.pnlCategory] || 0) + 1;
}

console.log(`\nГотово:`);
console.log(`  классифицировано: ${updated}`);
console.log(`  needs_review (confidence < ${CONFIDENCE_THRESHOLD}): ${needsReview}`);
console.log(`\nРазбивка по категориям:`);
for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(22)} ${n}`);
}

await sql.end({ timeout: 5 });
