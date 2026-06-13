/**
 * Список операций с группировкой по дням (§9).
 * Заголовок-дата (МСК) → операции этого дня в карточке-группе.
 */

import { TransactionRow } from './TransactionRow';
import { formatDayLabel, mskDayKey } from '../lib/dates';
import type { TransactionItem } from '../lib/types';

interface DayGroup {
  key: string;
  label: string;
  items: TransactionItem[];
}

/** Группирует операции по дню МСК, сохраняя исходный порядок (новые сверху). */
function groupByDay(txs: TransactionItem[]): DayGroup[] {
  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();
  for (const tx of txs) {
    const key = mskDayKey(tx.date);
    let group = index.get(key);
    if (!group) {
      group = { key, label: formatDayLabel(tx.date), items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(tx);
  }
  return groups;
}

export function TransactionList({
  transactions,
  onChanged,
}: {
  transactions: TransactionItem[];
  /** Перезапрос списка после смены категории в детальной карточке. */
  onChanged?: () => void;
}) {
  const groups = groupByDay(transactions);

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.key}>
          <h3 className="mb-2 px-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
            {group.label}
          </h3>
          <div className="divide-y divide-border rounded-md bg-surface-2 px-4">
            {group.items.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} onChanged={onChanged} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
