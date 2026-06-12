/**
 * Donut «Распределение выручки» (mini-app-design.md §6).
 * Целое = Выручка (totalIncome). 5 непересекающихся долей.
 * Центр = margin% (Прибыль / Выручка). Легенда-таблица = a11y-fallback.
 * Маркеры различаются формой (●/◆/■/▲/◆) и цветом.
 */

import { useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { rubles } from '../lib/money';
import type { AnalyticsSummary } from '../lib/types';

interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  marker: string; // форма маркера (носитель смысла помимо цвета)
}

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Палитра для фондов (по порядку) + зелёный для прибыли.
const FUND_COLORS = ['#38BDF8', '#FBBF24', '#94A3B8', '#A78BFA', '#F472B6', '#22D3EE'];
const PROFIT_COLOR = '#34D399';
const MARKERS = ['●', '■', '▲', '◆', '◇', '★', '⬟'];

function buildSegments(summary: AnalyticsSummary): Segment[] {
  // «Распределение выручки» по системе Карины: доход × % каждого фонда
  // (Благодарность 65%, Кредиты 10%, Налог 8%, Резерв 7%, Земля 5%) + Прибыль 5%.
  // Доли суммируются в 100% — фонды, обязательства и прибыль в одной диаграмме.
  let fundIdx = 0;
  return summary.distribution
    .filter((d) => d.amount > 0)
    .map((d, i) => ({
      key: `${d.kind}-${i}`,
      label: d.label,
      value: d.amount,
      color: d.kind === 'profit' ? PROFIT_COLOR : FUND_COLORS[fundIdx++ % FUND_COLORS.length]!,
      marker: MARKERS[i % MARKERS.length]!,
    }));
}

export function Donut({ summary }: { summary: AnalyticsSummary }) {
  const [active, setActive] = useState<string | null>(null);
  const revenue = summary.totalIncome;
  const segments = buildSegments(summary);
  const total = segments.reduce((acc, s) => acc + s.value, 0) || 1;

  const profitSlice = summary.distribution.find((d) => d.kind === 'profit');
  const marginPct = profitSlice ? Math.round(profitSlice.percent) : 0;

  const pct = (v: number): number => Math.round((v / total) * 100);

  const ariaLabel =
    `Распределение выручки ${rubles(revenue)}. ` +
    segments.map((s) => `${s.label}: ${pct(s.value)}%`).join(', ') +
    '.';

  return (
    <div>
      <p className="mb-1 text-[13px] font-medium text-ink-muted">
        Распределение выручки{' '}
        <span className="num text-ink">{rubles(revenue)}</span>
      </p>

      <div className="relative mx-auto" style={{ width: 200, height: 200 }} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={segments}
              dataKey="value"
              nameKey="label"
              innerRadius={64}
              outerRadius={88}
              paddingAngle={2}
              startAngle={90}
              endAngle={-270}
              cornerRadius={8}
              stroke="none"
              isAnimationActive={!prefersReducedMotion}
              animationDuration={600}
              onClick={(_, idx) => {
                const seg = segments[idx];
                setActive((cur) => (cur === seg?.key ? null : (seg?.key ?? null)));
              }}
            >
              {segments.map((s) => (
                <Cell
                  key={s.key}
                  fill={s.color}
                  opacity={active && active !== s.key ? 0.45 : 1}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* Центр кольца — margin % */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <b className="num text-[28px] font-bold leading-none text-ink">{marginPct}%</b>
          <span className="mt-1 text-[11px] font-medium uppercase tracking-[0.04em] text-ink-muted">
            Прибыль
          </span>
        </div>
      </div>

      {/* Легенда-таблица (обязательный a11y-fallback, §6.3) */}
      <ul className="mt-4 flex flex-col gap-2" aria-label="Доли распределения выручки">
        {segments.map((s) => {
          const isActive = active === s.key;
          return (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => setActive((cur) => (cur === s.key ? null : s.key))}
                className={`flex min-h-[44px] w-full items-center gap-3 rounded-sm px-2 text-left ${
                  isActive ? 'bg-surface-2' : ''
                }`}
              >
                <span
                  aria-hidden="true"
                  className="num w-4 shrink-0 text-center text-[14px] leading-none"
                  style={{ color: s.color }}
                >
                  {s.marker}
                </span>
                <span className="flex-1 truncate text-[14px] text-ink">{s.label}</span>
                <span className="num shrink-0 text-[14px] text-ink-muted">{rubles(s.value)}</span>
                <span className="num w-10 shrink-0 text-right text-[14px] font-semibold text-ink">
                  {pct(s.value)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Скрытая таблица для скринридеров */}
      <table className="sr-only">
        <caption>Распределение выручки {rubles(revenue)}</caption>
        <thead>
          <tr>
            <th>Доля</th>
            <th>Сумма</th>
            <th>Процент</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>{rubles(s.value)}</td>
              <td>{pct(s.value)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
