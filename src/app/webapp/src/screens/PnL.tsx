/**
 * Экран P&L (§P&L): отчёт о прибылях и убытках по юрлицам.
 * Вкладки ИП / ООО / Сводный / Год. Месячный режим — KPI + доходы + расходы +
 * чистая прибыль + личные траты собственника. Годовой режим — таблица + график.
 * Все суммы из API — в копейках.
 */

import { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowRight,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { Header } from '../components/Header';
import { SectionHeader } from '../components/AppLayout';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles, rublesCompact, rublesSigned, percentSigned } from '../lib/money';
import {
  currentMonthYm,
  currentYear,
  shiftYm,
  formatYmLabel,
} from '../lib/dates';
import { hapticSelection } from '../lib/telegram';
import type {
  PnlEntity,
  PnlResponse,
  PnlYearResponse,
  PnlYearMonth,
  PnlIncomeSources,
  PnlExpenseBreakdown,
} from '../lib/types';

type TabKey = 'ip' | 'ooo' | 'total' | 'year';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'ip', label: 'ИП' },
  { key: 'ooo', label: 'ООО' },
  { key: 'total', label: 'Сводный' },
  { key: 'year', label: 'Год' },
];

/** Подписи источников дохода. */
const INCOME_SOURCE_LABELS: Array<{ key: keyof PnlIncomeSources; label: string }> = [
  { key: 'prodamus', label: 'Продамус' },
  { key: 'robokassa', label: 'Робокасса' },
  { key: 'tochka_direct', label: 'Точка напрямую' },
  { key: 'lava', label: 'Lava.top' },
];

/** Подписи и порядок статей бизнес-расходов. */
const EXPENSE_LABELS: Array<{ key: keyof PnlExpenseBreakdown; label: string }> = [
  { key: 'payroll', label: 'ФОТ' },
  { key: 'marketing', label: 'Маркетинг' },
  { key: 'tax', label: 'Налог' },
  { key: 'subscriptions', label: 'Подписки' },
  { key: 'loan', label: 'Кредиты' },
  { key: 'payment_commission', label: 'Комиссии платёжек' },
  { key: 'other_business', label: 'Прочее' },
];

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

function monthShortLabel(ym: string): string {
  const m = Number(ym.split('-')[1]);
  return MONTHS_SHORT[(m || 1) - 1] ?? ym;
}

function formatPctValue(pct: number): string {
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(pct)}%`;
}

/** Стрелка изменения. up — рост (зелёный), down — падение (красный). */
function DeltaArrow({ pct }: { pct: number }) {
  const up = pct > 0;
  const down = pct < 0;
  const color = up ? 'var(--income)' : down ? 'var(--expense)' : 'var(--text-faint)';
  const Icon = up ? ArrowUp : down ? ArrowDown : ArrowRight;
  return (
    <span className="num inline-flex items-center gap-0.5 text-[12px]" style={{ color }}>
      <Icon size={13} strokeWidth={2.5} aria-hidden="true" />
      {percentSigned(pct)}
    </span>
  );
}

export function PnL() {
  const [tab, setTab] = useState<TabKey>('ip');
  const [month, setMonth] = useState<string>(() => currentMonthYm());
  const [year, setYear] = useState<number>(() => currentYear());

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">P&amp;L</h1>
        <p className="mb-4 text-[13px] text-ink-muted">
          Прибыли и убытки по юрлицам и направлениям.
        </p>

        {/* Вкладки */}
        <div className="mb-4 flex gap-1 rounded-pill bg-surface-1 p-1">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  hapticSelection();
                  setTab(t.key);
                }}
                className={`min-h-[36px] flex-1 rounded-pill text-[13px] font-semibold transition-colors ${
                  active ? 'bg-accent text-accent-ink shadow-glow' : 'text-ink-muted'
                }`}
                aria-pressed={active}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'year' ? (
          <YearSelector year={year} onChange={setYear} />
        ) : (
          <MonthSelector month={month} onChange={setMonth} />
        )}
      </section>

      <section className="mt-4 px-4 pb-4">
        {tab === 'year' ? (
          <YearView year={year} />
        ) : (
          <MonthView entity={tab} month={month} />
        )}
      </section>
    </>
  );
}

// ── Селекторы периода ────────────────────────────────────────────────────────

function MonthSelector({
  month,
  onChange,
}: {
  month: string;
  onChange: (ym: string) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md bg-surface-2 p-2">
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          onChange(shiftYm(month, -1));
        }}
        className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-ink-muted active:text-ink"
        aria-label="Предыдущий месяц"
      >
        <ChevronLeft size={20} strokeWidth={2} />
      </button>
      <span className="num text-[15px] font-semibold text-ink">{formatYmLabel(month)}</span>
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          onChange(shiftYm(month, 1));
        }}
        className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-ink-muted active:text-ink"
        aria-label="Следующий месяц"
      >
        <ChevronRight size={20} strokeWidth={2} />
      </button>
    </div>
  );
}

function YearSelector({
  year,
  onChange,
}: {
  year: number;
  onChange: (y: number) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md bg-surface-2 p-2">
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          onChange(year - 1);
        }}
        className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-ink-muted active:text-ink"
        aria-label="Предыдущий год"
      >
        <ChevronLeft size={20} strokeWidth={2} />
      </button>
      <span className="num text-[15px] font-semibold text-ink">{year}</span>
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          onChange(year + 1);
        }}
        className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-ink-muted active:text-ink"
        aria-label="Следующий год"
      >
        <ChevronRight size={20} strokeWidth={2} />
      </button>
    </div>
  );
}

// ── Месячный режим ───────────────────────────────────────────────────────────

function MonthView({ entity, month }: { entity: PnlEntity; month: string }) {
  const pnl = useAsync(() => api.pnl(entity, month), [entity, month]);
  const personal = useAsync(() => api.personalSpending(month), [month]);

  if (pnl.status === 'loading') {
    return <MonthSkeleton />;
  }
  if (pnl.status === 'error') {
    return <ErrorState message={pnl.error ?? undefined} onRetry={pnl.reload} />;
  }
  if (!pnl.data) {
    return <EmptyState title="Нет транзакций за период" hint="Выберите другой период." />;
  }

  const data = pnl.data;
  const empty = data.income.total === 0 && data.expenses.total === 0;
  if (empty) {
    return <EmptyState title="Нет транзакций за период" hint="Выберите другой период." />;
  }

  return (
    <div className="flex flex-col gap-6">
      <KpiGrid data={data} />
      {entity === 'total' ? <EntityProfitSummary month={month} /> : null}
      <IncomeBlock data={data} />
      <ExpenseBlock data={data} />
      <NetProfitBlock data={data} />
      <PersonalBlock
        total={personal.status === 'success' ? personal.data?.total ?? 0 : 0}
      />
    </div>
  );
}

/** Сводка прибыли по юрлицам (только на вкладке «Сводный»). */
function EntityProfitSummary({ month }: { month: string }) {
  const ip = useAsync(() => api.pnl('ip', month), [month]);
  const ooo = useAsync(() => api.pnl('ooo', month), [month]);
  if (ip.status !== 'success' || ooo.status !== 'success' || !ip.data || !ooo.data) return null;
  const ipP = ip.data.profit;
  const oooP = ooo.data.profit;
  const tot = ipP + oooP;
  const Row = ({ label, v, bold }: { label: string; v: number; bold?: boolean }) => (
    <div className={`flex items-center justify-between ${bold ? 'border-t border-white/10 pt-2 mt-1' : ''}`}>
      <span className={`text-[13px] ${bold ? 'font-semibold text-ink' : 'text-ink-muted'}`}>{label}</span>
      <span
        className={`num text-[14px] ${bold ? 'font-bold' : 'font-semibold'}`}
        style={{ color: v >= 0 ? 'var(--income)' : 'var(--expense)' }}
      >
        {rublesSigned(v)}
      </span>
    </div>
  );
  return (
    <div className="rounded-md bg-surface-2 p-4">
      <h3 className="mb-2 text-[13px] font-medium uppercase tracking-[0.04em] text-ink-faint">
        Прибыль по юрлицам
      </h3>
      <div className="flex flex-col gap-1.5">
        <Row label="ИП Еремян" v={ipP} />
        <Row label="ООО Ассургина" v={oooP} />
        <Row label="Итого (суммарно)" v={tot} bold />
      </div>
    </div>
  );
}

function KpiGrid({ data }: { data: PnlResponse }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <KpiTile
        label="Выручка"
        value={rublesCompact(data.income.total)}
        deltaPct={data.vs_prev_month.income_delta_pct}
        color="var(--income)"
      />
      <KpiTile
        label="Прибыль"
        value={rublesCompact(data.profit)}
        deltaPct={data.vs_prev_month.profit_delta_pct}
        color={data.profit >= 0 ? 'var(--income)' : 'var(--expense)'}
      />
      <KpiTile
        label="Расходы"
        value={rublesCompact(data.expenses.total)}
        color="var(--expense)"
      />
      <KpiTile
        label="Маржа"
        value={formatPctValue(data.margin_pct)}
        color="var(--accent)"
      />
    </div>
  );
}

function KpiTile({
  label,
  value,
  deltaPct,
  color,
}: {
  label: string;
  value: string;
  deltaPct?: number;
  color: string;
}) {
  return (
    <div className="rounded-md bg-surface-2 p-4">
      <p className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
        {label}
      </p>
      <p className="num mt-1 text-[20px] font-semibold" style={{ color }}>
        {value}
      </p>
      {deltaPct !== undefined ? (
        <div className="mt-1">
          <DeltaArrow pct={deltaPct} />
        </div>
      ) : null}
    </div>
  );
}

/** Строка «наименование — сумма (— % опционально)». */
function LineRow({
  label,
  amount,
  pct,
  color,
}: {
  label: string;
  amount: number;
  pct?: number;
  color?: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-2.5">
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{label}</span>
      {pct !== undefined ? (
        <span className="num shrink-0 text-[12px] text-ink-faint">{Math.round(pct)}%</span>
      ) : null}
      <span
        className="num shrink-0 text-[14px] font-semibold"
        style={{ color: color ?? 'var(--text)' }}
      >
        {rubles(amount)}
      </span>
    </li>
  );
}

function IncomeBlock({ data }: { data: PnlResponse }) {
  const rows = INCOME_SOURCE_LABELS.map((s) => ({
    label: s.label,
    amount: data.income.sources[s.key],
  })).filter((r): r is { label: string; amount: number } => typeof r.amount === 'number');

  return (
    <div>
      <SectionHeader title="Доходы" />
      <div className="rounded-md bg-surface-2 px-4 py-1">
        {rows.length > 0 ? (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <LineRow key={r.label} label={r.label} amount={r.amount} color="var(--income)" />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[13px] text-ink-faint">Нет данных по источникам.</p>
        )}
        <div className="flex items-baseline justify-between gap-3 border-t border-border py-3">
          <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
            Итого
          </span>
          <span className="num text-[15px] font-bold" style={{ color: 'var(--income)' }}>
            {rubles(data.income.total)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ExpenseBlock({ data }: { data: PnlResponse }) {
  const total = data.expenses.total;
  const rows = EXPENSE_LABELS.map((e) => ({
    label: e.label,
    amount: data.expenses.breakdown[e.key],
  })).filter(
    (r): r is { label: string; amount: number } => typeof r.amount === 'number' && r.amount !== 0
  );

  return (
    <div>
      <SectionHeader title="Расходы бизнеса" />
      <div className="rounded-md bg-surface-2 px-4 py-1">
        {rows.length > 0 ? (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <LineRow
                key={r.label}
                label={r.label}
                amount={r.amount}
                pct={total > 0 ? (r.amount / total) * 100 : 0}
                color="var(--expense)"
              />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[13px] text-ink-faint">Расходов за период нет.</p>
        )}
        <div className="flex items-baseline justify-between gap-3 border-t border-border py-3">
          <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
            Итого
          </span>
          <span className="num text-[15px] font-bold" style={{ color: 'var(--expense)' }}>
            {rubles(total)}
          </span>
        </div>
      </div>
    </div>
  );
}

function NetProfitBlock({ data }: { data: PnlResponse }) {
  const positive = data.profit >= 0;
  return (
    <div
      className="rounded-md p-4"
      style={{
        background: 'var(--grad-balance)',
        border: '1px solid var(--border-strong)',
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          Чистая прибыль бизнеса
        </span>
        <span className="num text-[11px] text-ink-faint">маржа {formatPctValue(data.margin_pct)}</span>
      </div>
      <p
        className="num mt-1 text-[28px] font-bold leading-[32px]"
        style={{ color: positive ? 'var(--income)' : 'var(--expense)' }}
      >
        {rubles(data.profit)}
      </p>
    </div>
  );
}

function PersonalBlock({ total }: { total: number }) {
  return (
    <div className="rounded-md bg-surface-1 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
          Личные расходы собственника
        </span>
        <span className="num text-[15px] font-semibold text-ink">{rubles(total)}</span>
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">не влияет на прибыль бизнеса</p>
    </div>
  );
}

function MonthSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-32 w-full rounded-md" />
      <Skeleton className="h-40 w-full rounded-md" />
    </div>
  );
}

// ── Годовой режим ────────────────────────────────────────────────────────────

interface YearChartPoint {
  month: string;
  Доходы: number;
  Расходы: number;
  Прибыль: number;
}

function YearView({ year }: { year: number }) {
  const pnl = useAsync(() => api.pnlYear('total', year), [year]);

  const chartData = useMemo<YearChartPoint[]>(() => {
    if (pnl.status !== 'success' || !pnl.data) return [];
    return pnl.data.months.map((m) => ({
      month: monthShortLabel(m.month),
      // копейки → рубли для оси графика
      Доходы: Math.round(m.income / 100),
      Расходы: Math.round(m.expenses / 100),
      Прибыль: Math.round(m.profit / 100),
    }));
  }, [pnl.status, pnl.data]);

  if (pnl.status === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-56 w-full rounded-md" />
        <Skeleton className="h-72 w-full rounded-md" />
      </div>
    );
  }
  if (pnl.status === 'error') {
    return <ErrorState message={pnl.error ?? undefined} onRetry={pnl.reload} />;
  }
  if (!pnl.data || pnl.data.months.length === 0) {
    return <EmptyState title="Нет транзакций за период" hint="Выберите другой год." />;
  }

  return (
    <div className="flex flex-col gap-6">
      <YearChart data={chartData} />
      <YearTable data={pnl.data} />
    </div>
  );
}

function compactAxis(rub: number): string {
  const abs = Math.abs(rub);
  if (abs >= 1_000_000) return `${Math.round(rub / 100_000) / 10}M`;
  if (abs >= 1_000) return `${Math.round(rub / 1_000)}K`;
  return String(rub);
}

function YearChart({ data }: { data: YearChartPoint[] }) {
  return (
    <div className="rounded-md bg-surface-2 p-3">
      <p className="mb-2 px-1 text-[13px] font-medium uppercase tracking-[0.04em] text-ink-muted">
        Динамика по месяцам, ₽
      </p>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--chart-track)" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fill: 'var(--text-faint)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--chart-track)' }}
            />
            <YAxis
              tick={{ fill: 'var(--text-faint)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={compactAxis}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface-1)',
                border: '1px solid var(--border-strong)',
                borderRadius: 12,
                fontSize: 12,
              }}
              labelStyle={{ color: 'var(--text-muted)' }}
              formatter={(value: number, name: string) => [
                `${new Intl.NumberFormat('ru-RU').format(value)} ₽`,
                name,
              ]}
            />
            <Line
              type="monotone"
              dataKey="Доходы"
              stroke="var(--income)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="Расходы"
              stroke="var(--expense)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="Прибыль"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-ink-muted">
        <LegendDot color="var(--income)" label="Доходы" />
        <LegendDot color="var(--expense)" label="Расходы" />
        <LegendDot color="var(--accent)" label="Прибыль" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function YearTable({ data }: { data: PnlYearResponse }) {
  return (
    <div className="overflow-hidden rounded-md bg-surface-2">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-ink-muted">
            <th className="px-3 py-2 font-medium">Месяц</th>
            <th className="px-2 py-2 text-right font-medium">Доход</th>
            <th className="px-2 py-2 text-right font-medium">Расход</th>
            <th className="px-2 py-2 text-right font-medium">Прибыль</th>
            <th className="px-3 py-2 text-right font-medium">Маржа</th>
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <YearRow key={m.month} m={m} />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-strong font-semibold text-ink">
            <td className="px-3 py-2.5">Итого</td>
            <td className="num px-2 py-2.5 text-right" style={{ color: 'var(--income)' }}>
              {rublesCompact(data.totals.income)}
            </td>
            <td className="num px-2 py-2.5 text-right" style={{ color: 'var(--expense)' }}>
              {rublesCompact(data.totals.expenses)}
            </td>
            <td
              className="num px-2 py-2.5 text-right"
              style={{ color: data.totals.profit >= 0 ? 'var(--income)' : 'var(--expense)' }}
            >
              {rublesCompact(data.totals.profit)}
            </td>
            <td className="num px-3 py-2.5 text-right">{formatPctValue(data.totals.margin_pct)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function YearRow({ m }: { m: PnlYearMonth }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-3 py-2.5 text-ink">{monthShortLabel(m.month)}</td>
      <td className="num px-2 py-2.5 text-right text-ink">{rublesCompact(m.income)}</td>
      <td className="num px-2 py-2.5 text-right text-ink">{rublesCompact(m.expenses)}</td>
      <td
        className="num px-2 py-2.5 text-right font-semibold"
        style={{ color: m.profit >= 0 ? 'var(--income)' : 'var(--expense)' }}
      >
        {rublesCompact(m.profit)}
      </td>
      <td className="num px-3 py-2.5 text-right text-ink-muted">{formatPctValue(m.margin_pct)}</td>
    </tr>
  );
}
