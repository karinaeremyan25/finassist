import { z } from 'zod';
import { getFundBalances, executeAllocation as repoExecuteAllocation } from '../db/repositories/funds.js';
import { getTransactionById } from '../db/repositories/transactions.js';
import { getSetting } from '../db/repositories/settings.js';
import { childLogger } from '../utils/logger.js';
import type { AllocationProposal, FundBalance, FundCode } from '../types.js';

/**
 * Сервис фондов.
 *
 * - proposeAllocation: считает предложение по процентам из settings.
 * - executeAllocation: атомарно создаёт fund_transactions через репозиторий.
 * - getFundBalance: текущий баланс одного фонда.
 * - Все суммы в bigint (копейки).
 */

const log = childLogger({ handler: 'funds' });

// ─────────────────────────────────────────────────────────────
// Zod-схемы
// ─────────────────────────────────────────────────────────────

const ProposeInputSchema = z.object({
  transactionId: z.string().uuid(),
});

const ExecuteInputSchema = z.object({
  proposal: z.object({
    sourceTransactionId: z.string().uuid(),
    amountKopecks: z.bigint().positive(),
    proposed: z.array(
      z.object({
        fundCode: z.enum(['tax', 'reserve', 'development', 'personal']),
        percentage: z.number().min(0).max(100),
        amountKopecks: z.bigint().positive(),
      })
    ),
  }),
  customPercentages: z
    .object({
      tax: z.number().min(0).max(100),
      reserve: z.number().min(0).max(100),
      development: z.number().min(0).max(100),
    })
    .optional(),
  executedBy: z.string().uuid(),
});

const FundBalanceInputSchema = z.object({
  fundCode: z.enum(['tax', 'reserve', 'development', 'personal']),
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const DEFAULT_FUND_PERCENTAGES: Record<FundCode, number> = {
  tax: 6,
  reserve: 10,
  development: 15,
  personal: 69,
};

/** Читает процент фонда из settings, fallback к дефолту. */
async function getFundPercentage(fundCode: FundCode): Promise<number> {
  const key = `fund_percentage_${fundCode}`;
  const val = await getSetting(key);
  if (typeof val === 'number' && val >= 0 && val <= 100) return val;
  return DEFAULT_FUND_PERCENTAGES[fundCode];
}

/** Читает порог крупного поступления (в копейках). Default: 10 000 000 (100 000 ₽). */
async function getLargeIncomeThreshold(): Promise<bigint> {
  const val = await getSetting('large_income_threshold');
  if (typeof val === 'number' && val > 0) return BigInt(val);
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n > 0) return BigInt(n);
  }
  return 10_000_000n; // 100 000 ₽ по умолчанию
}

// ─────────────────────────────────────────────────────────────
// proposeAllocation
// ─────────────────────────────────────────────────────────────

/**
 * Предлагает распределение поступления по фондам.
 * Если amount < large_income_threshold → возвращает null.
 * «personal» — остаток (100% − остальные).
 */
export async function proposeAllocation(
  transactionId: string
): Promise<AllocationProposal | null> {
  ProposeInputSchema.parse({ transactionId });

  const tx = await getTransactionById(transactionId);
  if (tx === null) {
    throw new Error(`proposeAllocation: transaction ${transactionId} not found`);
  }

  const threshold = await getLargeIncomeThreshold();
  if (tx.amountRub < threshold) {
    log.info(
      {
        transaction_id: transactionId,
        amount_rub: tx.amountRub.toString(),
        threshold: threshold.toString(),
      },
      'funds_below_threshold'
    );
    return null;
  }

  const taxPct = await getFundPercentage('tax');
  const reservePct = await getFundPercentage('reserve');
  const developmentPct = await getFundPercentage('development');

  // personal = остаток
  const personalPct = Math.max(0, 100 - taxPct - reservePct - developmentPct);

  const amount = tx.amountRub;

  const taxAmount = (amount * BigInt(Math.round(taxPct * 100))) / 10_000n;
  const reserveAmount = (amount * BigInt(Math.round(reservePct * 100))) / 10_000n;
  const developmentAmount = (amount * BigInt(Math.round(developmentPct * 100))) / 10_000n;
  // personal — точный остаток, чтобы избежать копеечных расхождений
  const personalAmount = amount - taxAmount - reserveAmount - developmentAmount;

  const proposal: AllocationProposal = {
    sourceTransactionId: transactionId,
    amountKopecks: amount,
    proposed: [
      { fundCode: 'tax', percentage: taxPct, amountKopecks: taxAmount },
      { fundCode: 'reserve', percentage: reservePct, amountKopecks: reserveAmount },
      { fundCode: 'development', percentage: developmentPct, amountKopecks: developmentAmount },
      { fundCode: 'personal', percentage: personalPct, amountKopecks: personalAmount },
    ],
  };

  log.info(
    {
      transaction_id: transactionId,
      amount: amount.toString(),
      funds: proposal.proposed.map((p) => ({
        code: p.fundCode,
        pct: p.percentage,
        amount: p.amountKopecks.toString(),
      })),
    },
    'funds_proposal_created'
  );

  return proposal;
}

// ─────────────────────────────────────────────────────────────
// executeAllocation
// ─────────────────────────────────────────────────────────────

/**
 * Выполняет распределение атомарно.
 * При customPercentages пересчитывает суммы по новым процентам.
 */
export async function executeAllocation(
  proposal: AllocationProposal,
  customPercentages?: { tax: number; reserve: number; development: number },
  executedBy?: string
): Promise<void> {
  const parsed = ExecuteInputSchema.parse({ proposal, customPercentages, executedBy: executedBy ?? '' });

  let finalProposed = parsed.proposal.proposed;

  if (parsed.customPercentages !== undefined) {
    const { tax, reserve, development } = parsed.customPercentages;
    const personal = Math.max(0, 100 - tax - reserve - development);
    const sum = tax + reserve + development + personal;
    if (Math.abs(sum - 100) > 0.01) {
      throw new Error(`executeAllocation: percentages sum to ${sum}, expected 100`);
    }
    const amount = parsed.proposal.amountKopecks;
    const taxAmt = (amount * BigInt(Math.round(tax * 100))) / 10_000n;
    const reserveAmt = (amount * BigInt(Math.round(reserve * 100))) / 10_000n;
    const developmentAmt = (amount * BigInt(Math.round(development * 100))) / 10_000n;
    const personalAmt = amount - taxAmt - reserveAmt - developmentAmt;

    finalProposed = [
      { fundCode: 'tax', percentage: tax, amountKopecks: taxAmt },
      { fundCode: 'reserve', percentage: reserve, amountKopecks: reserveAmt },
      { fundCode: 'development', percentage: development, amountKopecks: developmentAmt },
      { fundCode: 'personal', percentage: personal, amountKopecks: personalAmt },
    ];
  }

  const tx = await getTransactionById(parsed.proposal.sourceTransactionId);
  const occurredAt = tx?.occurredAt ?? new Date().toISOString().slice(0, 10);

  await repoExecuteAllocation(
    finalProposed.map((p) => ({
      fundCode: p.fundCode,
      amountKopecks: p.amountKopecks,
      percentage: p.percentage,
      sourceTransactionId: parsed.proposal.sourceTransactionId,
      occurredAt,
    })),
    parsed.executedBy
  );

  log.info(
    {
      transaction_id: parsed.proposal.sourceTransactionId,
      executed_by: parsed.executedBy,
      funds: finalProposed.map((p) => ({
        code: p.fundCode,
        amount: p.amountKopecks.toString(),
      })),
    },
    'funds_allocation_executed'
  );
}

// ─────────────────────────────────────────────────────────────
// getFundBalance
// ─────────────────────────────────────────────────────────────

/** Текущий баланс одного фонда в копейках. */
export async function getFundBalance(fundCode: string): Promise<bigint> {
  FundBalanceInputSchema.parse({ fundCode });

  const balances = await getFundBalances();
  const fund = balances.find((b) => b.code === fundCode);
  return fund?.balanceKopecks ?? 0n;
}

// ─────────────────────────────────────────────────────────────
// getAllFundBalances
// ─────────────────────────────────────────────────────────────

/** Балансы всех фондов (для экрана /funds). */
export async function getAllFundBalances(asOfDate?: string): Promise<FundBalance[]> {
  return getFundBalances(asOfDate);
}
