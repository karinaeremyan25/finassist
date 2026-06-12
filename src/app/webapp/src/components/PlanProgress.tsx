/**
 * Блок «План / Факт / %» (mini-app, §План).
 * Две строки: Доход / Расход. Для каждой — факт, план-минимум,
 * прогресс-бар (pctOfMin) и подпись «% от плана-минимум».
 * Данные приходят из /api/analytics/plan, суммы — в копейках.
 */

import { rubles } from '../lib/money';
import type { PlanLine, PlanResponse } from '../lib/types';

function clampPct(pct: number): number {
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

function PlanRow({
  label,
  line,
  color,
}: {
  label: string;
  line: PlanLine;
  color: string;
}) {
  const hasPlan = line.min !== null && line.min > 0;
  const pct = line.pctOfMin;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          {label}
        </span>
        <span className="num text-[15px] font-semibold text-ink">{rubles(line.actual)}</span>
      </div>

      {hasPlan ? (
        <>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-pill"
            style={{ background: 'var(--chart-track)' }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct !== null ? Math.round(pct) : 0}
            aria-label={`${label}: ${pct !== null ? Math.round(pct) : 0}% от плана-минимум`}
          >
            <div
              className="h-full rounded-pill transition-[width]"
              style={{ width: `${clampPct(pct ?? 0)}%`, background: color }}
            />
          </div>

          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="text-[11px] text-ink-faint">
              {pct !== null ? `${pct}% от плана-минимум` : 'план-минимум не задан'}
            </span>
            <span className="num text-[11px] text-ink-faint">
              мин {rubles(line.min ?? 0)}
              {line.avg !== null ? ` · ср ${rubles(line.avg)}` : ''}
              {line.max !== null ? ` · макс ${rubles(line.max)}` : ''}
            </span>
          </div>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-ink-faint">План не задан</p>
      )}
    </div>
  );
}

export function PlanProgress({ data }: { data: PlanResponse }) {
  return (
    <div className="flex flex-col gap-4 rounded-md bg-surface-2 p-4">
      <PlanRow label="Доход" line={data.income} color="var(--income)" />
      <PlanRow label="Расход" line={data.expense} color="var(--expense)" />
    </div>
  );
}
