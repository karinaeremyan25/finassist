/** Компактные фильтры: юрлицо, направление, период (пишут в общий стейт). */

import { useApp } from '../state/FilterContext';
import type { SessionEntity } from '../lib/types';

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: SessionEntity[];
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="min-h-[44px] w-full rounded-sm border border-border bg-surface-2 px-3 text-[14px] text-ink"
      >
        <option value="">Все</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterBar({
  entities,
  directions,
}: {
  entities: SessionEntity[];
  directions: SessionEntity[];
}) {
  const { entityId, directionId, period, setEntity, setDirection, setPeriod } = useApp();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Select label="Юрлицо" value={entityId} options={entities} onChange={setEntity} />
        <Select label="Направление" value={directionId} options={directions} onChange={setDirection} />
      </div>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">С</span>
          <input
            type="date"
            value={period.from}
            onChange={(e) => setPeriod({ ...period, from: e.target.value })}
            className="num min-h-[44px] w-full rounded-sm border border-border bg-surface-2 px-3 text-[14px] text-ink"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">По</span>
          <input
            type="date"
            value={period.to}
            onChange={(e) => setPeriod({ ...period, to: e.target.value })}
            className="num min-h-[44px] w-full rounded-sm border border-border bg-surface-2 px-3 text-[14px] text-ink"
          />
        </label>
      </div>
    </div>
  );
}
