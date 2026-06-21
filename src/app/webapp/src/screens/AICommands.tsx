/**
 * Экран AI-оркестратор (SPEC v2.1 US-105). Поле команды → разбор моделью →
 * карточка-превью с Approve/Reject. Денежные действия выполняются только после
 * подтверждения. Все суммы из API — копейки/рубли по контексту.
 */

import { useState } from 'react';
import { Send, Check, X } from 'lucide-react';
import { Header } from '../components/Header';
import { useApp } from '../state/FilterContext';
import { api } from '../lib/api';
import { hapticSelection } from '../lib/telegram';
import type { AiCommandResponse, AiCommandApproveResponse } from '../lib/types';

const TYPE_LABEL: Record<string, string> = {
  create_invoice: 'Счёт',
  create_payment: 'Платёжка / налог',
  reclassify: 'Переклассификация',
  query: 'Вопрос',
  unknown: 'Не распознано',
};

const EXAMPLES = [
  'Счёт на Гайнетдинову 25000',
  'Платёжка в ФНС на налог',
  'Перемести «коммунизм» в ФОТ',
];

export function AICommands() {
  const { session } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<AiCommandResponse | null>(null);
  const [result, setResult] = useState<AiCommandApproveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setParsed(null);
    try {
      const res = await api.aiCommand(text.trim());
      setParsed(res);
    } catch {
      setError('Не удалось обработать команду. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(approved: boolean) {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.aiCommandApprove(parsed.id, approved);
      setResult(res);
      setParsed(null);
      if (approved) setText('');
    } catch {
      setError('Не удалось выполнить команду.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header />
      <section className="px-4 -mt-2">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">AI-команды</h1>
        <p className="mb-4 text-[13px] text-ink-muted">
          Создавайте счета, считайте налог, переклассифицируйте — текстом.
        </p>

        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="Например: счёт на Гайнетдинову 25000"
            className="min-h-[48px] flex-1 resize-none rounded-md bg-surface-2 px-3 py-2 text-[14px] text-ink placeholder:text-ink-faint"
          />
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => {
              hapticSelection();
              void send();
            }}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-accent text-accent-ink shadow-glow active:opacity-90 disabled:opacity-50"
            aria-label="Отправить"
          >
            <Send size={20} strokeWidth={2} />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setText(ex)}
              className="rounded-pill border border-border-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink-muted active:bg-surface-3"
            >
              {ex}
            </button>
          ))}
        </div>

        {error ? <p className="mt-4 text-[13px] text-expense">{error}</p> : null}

        {parsed ? (
          <div className="mt-5 rounded-md bg-surface-2 p-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-faint">
              {TYPE_LABEL[parsed.ai_response.type] ?? parsed.ai_response.type}
            </p>
            <p className="mt-1 text-[15px] text-ink">{parsed.ai_response.preview}</p>

            {parsed.status === 'needs_clarification' ? (
              <p className="mt-2 text-[13px] text-warning">
                Нужно уточнение — добавьте недостающие детали и отправьте снова.
              </p>
            ) : parsed.needs_approval ? (
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(true)}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-pill bg-accent text-[14px] font-semibold text-accent-ink shadow-glow active:opacity-90 disabled:opacity-60"
                >
                  <Check size={18} strokeWidth={2.5} />
                  Выполнить
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(false)}
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-pill border border-border-strong px-5 text-[14px] text-ink-muted active:bg-surface-3 disabled:opacity-60"
                >
                  <X size={18} strokeWidth={2.5} />
                  Отмена
                </button>
              </div>
            ) : (
              <p className="mt-2 text-[13px] text-ink-faint">Команда-вопрос — задайте её в разделе «Чат».</p>
            )}
          </div>
        ) : null}

        {result ? (
          <div className="mt-5 rounded-md bg-surface-1 p-4">
            <p className="text-[14px] font-semibold text-ink">
              {result.status === 'executed' ? 'Выполнено' : result.status === 'rejected' ? 'Отклонено' : 'Не выполнено'}
            </p>
            {result.result ? <ResultView result={result.result} /> : null}
          </div>
        ) : null}

        {!session ? null : (
          <p className="mt-6 text-[12px] text-ink-faint">
            Все команды логируются. Денежные действия выполняются только после подтверждения.
          </p>
        )}
      </section>
    </>
  );
}

function ResultView({ result }: { result: Record<string, unknown> }) {
  const note = typeof result['note'] === 'string' ? (result['note'] as string) : null;
  const entries = Object.entries(result).filter(([k]) => k !== 'note');
  return (
    <div className="mt-2">
      <ul className="divide-y divide-border">
        {entries.map(([k, v]) => (
          <li key={k} className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
            <span className="text-ink-muted">{k}</span>
            <span className="num text-right text-ink">{String(v)}</span>
          </li>
        ))}
      </ul>
      {note ? <p className="mt-2 text-[12px] text-ink-faint">{note}</p> : null}
    </div>
  );
}
