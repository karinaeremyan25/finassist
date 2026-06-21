/**
 * Репозиторий выученных правил переклассификации (SPEC_FinAssist_v2.1 US-103).
 *
 * Когда пользователь перемещает операцию в другую pnl_category, мы сохраняем
 * правило keyword→category. Классификатор затем применяет правила детерминированно
 * (приоритет: PAYROLL_PAYEES → category_rules → Claude → default), что даёт эффект
 * «AI учится» без дообучения модели.
 *
 * keyword нормализуется в нижний регистр. company_id NULL = правило для обоих юрлиц.
 */

import { sql } from '../client.js';
import { ENTITY_IDS } from './pnl.js';
import type { Company } from './contractors.js';

/** Контекст транзакции для вывода keyword и company при обучении правила. */
export interface TxRuleContext {
  counterparty: string | null;
  description: string | null;
  company: Company | null;
}

/** entity_id → 'ip'|'ooo'|null (по seed-константам ENTITY_IDS). */
function entityToCompany(entityId: string | null): Company | null {
  if (entityId === ENTITY_IDS.ip) return 'ip';
  if (entityId === ENTITY_IDS.ooo) return 'ooo';
  return null;
}

/** Тянет counterparty/description/company транзакции (для обучения правила). */
export async function getTxRuleContext(txId: string): Promise<TxRuleContext | null> {
  const rows = await sql<{ counterparty: string | null; description: string | null; entity_id: string | null }[]>`
    SELECT counterparty, description, entity_id::text AS entity_id
    FROM transactions
    WHERE id = ${txId}::uuid AND deleted_at IS NULL
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return { counterparty: r.counterparty, description: r.description, company: entityToCompany(r.entity_id) };
}

export interface CategoryRule {
  keyword: string;
  targetPnlCategory: string;
  companyId: Company | null;
  confidence: number;
  hitCount: number;
}

/**
 * Извлекает keyword из текста операции для правила.
 * Берём counterparty (приоритет) или первые слова description, нормализуем,
 * ограничиваем длиной. Возвращает null, если осмысленного ключа нет.
 */
export function deriveKeyword(counterparty: string | null, description: string | null): string | null {
  const base = (counterparty && counterparty.trim().length > 0 ? counterparty : description) ?? '';
  const normalized = base
    .toLowerCase()
    .replace(/[«»"'(),.;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length < 3) return null;
  // Берём первые 6 слов — достаточно специфично, но устойчиво к хвостам реквизитов.
  return normalized.split(' ').slice(0, 6).join(' ').slice(0, 120);
}

/**
 * Создаёт/обновляет правило при переклассификации.
 * Новое правило перезаписывает старую категорию (edge case #3), confidence=0.85,
 * hit_count инкрементится.
 */
export async function upsertRule(
  keyword: string,
  targetPnlCategory: string,
  companyId: Company | null,
  createdBy: string | null
): Promise<void> {
  await sql`
    INSERT INTO category_rules (keyword, target_pnl_category, company_id, confidence, hit_count, created_by)
    VALUES (${keyword}, ${targetPnlCategory}, ${companyId}, 0.85, 1, ${createdBy}::uuid)
    ON CONFLICT (keyword, COALESCE(company_id, ''))
    DO UPDATE SET
      target_pnl_category = EXCLUDED.target_pnl_category,
      confidence = 0.85,
      hit_count = category_rules.hit_count + 1,
      updated_at = NOW()
  `;
}

/** Загружает все правила (для применения в классификаторе). Малая таблица. */
export async function listRules(): Promise<CategoryRule[]> {
  const rows = await sql<{
    keyword: string;
    target_pnl_category: string;
    company_id: Company | null;
    confidence: string;
    hit_count: number;
  }[]>`
    SELECT keyword, target_pnl_category, company_id, confidence, hit_count
    FROM category_rules
    ORDER BY char_length(keyword) DESC
  `;
  return rows.map((r) => ({
    keyword: r.keyword,
    targetPnlCategory: r.target_pnl_category,
    companyId: r.company_id,
    confidence: Number(r.confidence),
    hitCount: r.hit_count,
  }));
}

/**
 * Находит подходящее правило для операции: keyword входит в нормализованный текст,
 * company совпадает (или правило глобальное). Возвращает наиболее специфичное
 * (самый длинный keyword — listRules уже отсортирован по длине убыв.).
 */
export function matchRule(
  rules: CategoryRule[],
  counterparty: string | null,
  description: string | null,
  company: Company | null
): CategoryRule | null {
  const haystack = `${counterparty ?? ''} ${description ?? ''}`.toLowerCase();
  if (haystack.trim().length === 0) return null;
  for (const rule of rules) {
    if (rule.companyId !== null && company !== null && rule.companyId !== company) continue;
    if (haystack.includes(rule.keyword)) return rule;
  }
  return null;
}
