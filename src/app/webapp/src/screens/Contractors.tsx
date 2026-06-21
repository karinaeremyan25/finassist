/**
 * Экран Контрагенты (SPEC v2.1 US-102). Карточки контрагентов: выставлено/оплачено/
 * остаток. Разворот → счета + платежи (клик на платёж → чек Точки). Кнопка
 * «Новый счёт» (только ООО, edge case #5). Суммы из API — копейки.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { SubHeader } from '../components/SubHeader';
import { Skeleton, ErrorState, EmptyState } from '../components/States';
import { useAsync } from '../lib/useAsync';
import { api } from '../lib/api';
import { rubles, rublesSigned } from '../lib/money';
import { hapticSelection } from '../lib/telegram';
import type { Company, ContractorRow, InvoiceStatus } from '../lib/types';

const FILTERS: Array<{ key: Company; label: string }> = [
  { key: 'ooo', label: 'ООО' },
  { key: 'ip', label: 'ИП' },
];

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'черновик',
  sent: 'отправлен',
  paid: 'оплачен',
  cancelled: 'отменён',
};

export function Contractors() {
  const [company, setCompany] = useState<Company>('ooo');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const list = useAsync(() => api.contractors(company), [company]);

  async function syncFromTochka() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await api.syncContractors(company);
      setSyncMsg(res.created > 0 ? `Загружено новых: ${res.created}` : 'Новых контрагентов нет');
      list.reload();
    } catch {
      setSyncMsg('Не удалось загрузить из Точки');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <SubHeader title="Контрагенты" />
      <section className="px-4 pt-3">
        <p className="mb-4 text-[13px] text-ink-muted">Счета, платежи и остаток задолженности.</p>

        <div className="mb-3 flex gap-1 rounded-pill bg-surface-1 p-1">
          {FILTERS.map((f) => {
            const active = f.key === company;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => {
                  hapticSelection();
                  setCompany(f.key);
                }}
                className={`min-h-[36px] flex-1 rounded-pill text-[13px] font-semibold transition-colors ${
                  active ? 'bg-accent text-accent-ink shadow-glow' : 'text-ink-muted'
                }`}
                aria-pressed={active}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          disabled={syncing}
          onClick={() => {
            hapticSelection();
            void syncFromTochka();
          }}
          className="mb-2 inline-flex min-h-[40px] items-center gap-1.5 rounded-pill border border-border-strong bg-surface-2 px-4 text-[13px] font-medium text-ink active:bg-surface-3 disabled:opacity-60"
        >
          <RefreshCw size={15} strokeWidth={2} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Загружаю из Точки…' : 'Загрузить из Точки'}
        </button>
        {syncMsg ? <p className="mb-2 text-[12px] text-ink-muted">{syncMsg}</p> : null}
      </section>

      <section className="px-4 pb-4">
        {list.status === 'loading' ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        ) : list.status === 'error' ? (
          <ErrorState message={list.error ?? undefined} onRetry={list.reload} />
        ) : !list.data || list.data.data.length === 0 ? (
          <EmptyState title="Нет контрагентов" hint="Нажмите «Загрузить из Точки» — заведём контрагентов из выписки." />
        ) : (
          <ul className="flex flex-col gap-3">
            {list.data.data.map((c) => (
              <ContractorCard key={c.id} c={c} onChange={list.reload} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ContractorCard({ c, onChange }: { c: ContractorRow; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const owed = c.balance_owed;
  return (
    <li className="overflow-hidden rounded-md bg-surface-2">
      <button
        type="button"
        onClick={() => {
          hapticSelection();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-3"
        aria-expanded={open}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-ink">{c.name}</span>
          <span className="block truncate text-[12px] text-ink-faint">
            выставлено {rubles(c.total_invoiced)} · оплачено {rubles(c.total_paid)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="num block text-[11px] text-ink-faint">остаток</span>
          <span
            className="num block text-[14px] font-semibold"
            style={{ color: owed > 0 ? 'var(--warning)' : 'var(--income)' }}
          >
            {rubles(owed)}
          </span>
        </span>
        {open ? (
          <ChevronDown size={18} className="shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight size={18} className="shrink-0 text-ink-faint" />
        )}
      </button>

      {open ? (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-1 text-[12px] font-medium uppercase tracking-[0.04em] text-ink-muted">Счета</p>
          {c.invoices.length > 0 ? (
            <ul className="divide-y divide-border">
              {c.invoices.map((i) => (
                <li key={i.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    №{i.invoice_number} · {STATUS_LABEL[i.status]}
                    {i.description ? ` · ${i.description}` : ''}
                  </span>
                  <span className="num shrink-0 text-[13px] font-semibold text-ink">{rubles(i.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-1 text-[12px] text-ink-faint">Счетов нет.</p>
          )}

          <p className="mb-1 mt-3 text-[12px] font-medium uppercase tracking-[0.04em] text-ink-muted">Платежи</p>
          {c.payments.length > 0 ? (
            <ul className="divide-y divide-border">
              {c.payments.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{p.description ?? 'Платёж'}</span>
                    <span className="num block text-[11px] text-ink-faint">
                      {p.date.slice(0, 10)}
                      {p.tochka_transaction_id ? ' · чек Точки' : ''}
                    </span>
                  </span>
                  <span
                    className="num shrink-0 text-[13px] font-semibold"
                    style={{ color: p.amount < 0 ? 'var(--expense)' : 'var(--income)' }}
                  >
                    {rublesSigned(p.amount)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-1 text-[12px] text-ink-faint">Платежей нет.</p>
          )}

          {c.company_id === 'ooo' ? (
            <NewInvoice contractorId={c.id} onCreated={onChange} />
          ) : (
            <p className="mt-3 text-[12px] text-ink-faint">Счета доступны только для ООО.</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function NewInvoice({ contractorId, onCreated }: { contractorId: string; onCreated: () => void }) {
  const [form, setForm] = useState(false);
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    if (!amount.trim()) {
      setMsg('Укажите сумму');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.generateInvoice({ contractor_id: contractorId, amount, description: desc || null });
      setMsg(`Счёт №${res.invoice_number} создан (черновик)`);
      setAmount('');
      setDesc('');
      setForm(false);
      onCreated();
    } catch {
      setMsg('Не удалось создать счёт');
    } finally {
      setBusy(false);
    }
  }

  if (!form) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => {
            hapticSelection();
            setForm(true);
            setMsg(null);
          }}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-pill bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-glow active:opacity-90"
        >
          <Plus size={16} strokeWidth={2.5} />
          Новый счёт
        </button>
        {msg ? <p className="mt-2 text-[12px] text-ink-muted">{msg}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md bg-surface-1 p-3">
      <input
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Сумма, ₽"
        className="min-h-[40px] rounded-md bg-surface-3 px-3 text-[14px] text-ink placeholder:text-ink-faint"
      />
      <input
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="Описание (необязательно)"
        className="min-h-[40px] rounded-md bg-surface-3 px-3 text-[14px] text-ink placeholder:text-ink-faint"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="min-h-[40px] flex-1 rounded-pill bg-accent text-[13px] font-semibold text-accent-ink shadow-glow active:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Создаю…' : 'Создать'}
        </button>
        <button
          type="button"
          onClick={() => setForm(false)}
          className="min-h-[40px] rounded-pill border border-border-strong px-4 text-[13px] text-ink-muted"
        >
          Отмена
        </button>
      </div>
      {msg ? <p className="text-[12px] text-ink-muted">{msg}</p> : null}
    </div>
  );
}
