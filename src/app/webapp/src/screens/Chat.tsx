/**
 * Вкладка «AI» — единый ассистент: отвечает как наставник (аналитика, советы)
 * И выполняет действия оркестратора (счёт, расчёт налога, переклассификация),
 * плюс голосовая диктовка. POST /api/ai/assistant → answer | action.
 */

import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { SendHorizontal, Sparkles, Trash2, Mic, Square, Check, X } from 'lucide-react';
import { Header } from '../components/Header';
import { useApp, useFilters, type ChatMessage } from '../state/FilterContext';
import { api, ApiClientError } from '../lib/api';
import { openLink } from '../lib/telegram';
import type { AiAssistantAction } from '../lib/types';

const ERROR_HINTS: Record<string, string> = {
  off_topic: 'Я помогаю с финансами и аналитикой, а также создаю счета, считаю налог и переклассифицирую расходы.',
  insufficient_data: 'Недостаточно данных за выбранный период. Попробуйте расширить период.',
  ai_unavailable: 'AI временно недоступен. Попробуйте позже.',
  invalid_request: 'Сообщение не может быть пустым.',
  network_error: 'Нет соединения с сервером.',
};

const TYPE_LABEL: Record<string, string> = {
  create_invoice: 'Счёт',
  create_payment: 'Платёжка / налог',
  reclassify: 'Переклассификация',
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Человекочитаемая сводка результата выполненного действия. */
function formatResult(result: Record<string, unknown> | undefined): string {
  if (!result) return 'Готово.';
  if (result['invoice_number']) {
    return `✅ Счёт №${String(result['invoice_number'])} создан${result['contractor'] ? ` на «${String(result['contractor'])}»` : ''} (черновик).`;
  }
  if (result['tax_amount_formatted']) {
    return `🧮 Налог к уплате: ${String(result['tax_amount_formatted'])}.\n${String(result['note'] ?? '')}`;
  }
  if (result['rule_created']) {
    return `🧠 Правило сохранено: «${String(result['keyword'])}» → ${String(result['target_category'])}. Будущие операции пойдут в эту категорию.`;
  }
  if (typeof result['note'] === 'string') return result['note'];
  return 'Готово.';
}

export function Chat() {
  const { period, entity_id } = useFilters();
  const { chatMessages, addChatMessage, clearChat } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AiAssistantAction | null>(null);

  // Голос
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const micAvailable =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof MediaRecorder !== 'undefined';

  async function send() {
    const question = input.trim();
    if (question.length === 0) {
      addChatMessage({ role: 'error', text: ERROR_HINTS['invalid_request']! });
      return;
    }
    setInput('');
    setPending(null);
    addChatMessage({ role: 'user', text: question });
    setBusy(true);
    try {
      const res = await api.aiAssistant({
        question,
        entity_id,
        from: period.from,
        to: period.to,
        context: 'dashboard',
      });
      if (res.kind === 'action') {
        setPending(res);
      } else {
        addChatMessage({ role: 'assistant', text: res.answer });
      }
    } catch (err) {
      const code = err instanceof ApiClientError ? err.code : 'network_error';
      const msg = err instanceof ApiClientError && !ERROR_HINTS[code] ? err.message : ERROR_HINTS[code];
      addChatMessage({ role: 'error', text: msg ?? 'Ошибка запроса.' });
    } finally {
      setBusy(false);
    }
  }

  async function decide(approved: boolean) {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await api.aiCommandApprove(pending.id, approved);
      if (!approved || res.status === 'rejected') {
        addChatMessage({ role: 'assistant', text: 'Отменено.' });
      } else if (res.status === 'executed') {
        addChatMessage({ role: 'assistant', text: formatResult(res.result) });
      } else {
        addChatMessage({ role: 'error', text: formatResult(res.result) || 'Не удалось выполнить.' });
      }
    } catch {
      addChatMessage({ role: 'error', text: 'Не удалось выполнить команду.' });
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function toggleRec() {
    if (recording) {
      mediaRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const b64 = await blobToBase64(blob);
          const res = await api.transcribe(b64, blob.type || 'audio/webm');
          if (res.text) setInput((cur) => (cur ? `${cur} ${res.text}` : res.text!));
          else if (res.error) addChatMessage({ role: 'error', text: res.error });
        } catch {
          addChatMessage({ role: 'error', text: 'Не удалось распознать речь.' });
        } finally {
          setTranscribing(false);
        }
      };
      mediaRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      addChatMessage({ role: 'error', text: 'Микрофон недоступен. Разрешите доступ к микрофону в настройках.' });
    }
  }

  return (
    <>
      <Header />
      <div className="flex flex-col px-4 -mt-2" style={{ minHeight: 'calc(100vh - 140px)' }}>
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-[22px] font-semibold text-ink">AI-ассистент</h1>
          {chatMessages.length > 0 ? (
            <button
              type="button"
              onClick={clearChat}
              aria-label="Очистить чат"
              className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-ink-faint active:opacity-70"
            >
              <Trash2 size={15} strokeWidth={2} />
              Очистить
            </button>
          ) : null}
        </div>

        <div className="flex-1 space-y-3 pb-4">
          {chatMessages.length === 0 && !pending ? (
            <div className="rounded-md bg-surface-2 p-4">
              <div className="mb-1 flex items-center gap-2 text-accent">
                <Sparkles size={16} strokeWidth={2} />
                <span className="text-[15px] font-semibold text-ink">Спросите или дайте команду</span>
              </div>
              <p className="text-[13px] leading-[18px] text-ink-muted">
                Советы: «Какие расходы сократить?», «Почему июнь в минусе?»<br />
                Команды: «Счёт на Гайнетдинову 25000», «Платёжка в ФНС на налог», «Перемести „коммунизм“ в ФОТ».<br />
                Можно надиктовать голосом 🎤.
              </p>
            </div>
          ) : (
            chatMessages.map((m) => <Bubble key={m.id} msg={m} />)
          )}
          {pending ? <ActionCard action={pending} busy={busy} onDecide={decide} /> : null}
          {busy && !pending ? <div className="text-[13px] text-ink-faint">AI печатает…</div> : null}
          {transcribing ? <div className="text-[13px] text-ink-faint">Распознаю речь…</div> : null}
        </div>

        <div className="safe-bottom sticky bottom-0 bg-bg-deep pt-2 pb-[calc(72px+env(safe-area-inset-bottom,0px))]">
          <div className="flex items-end gap-2">
            {micAvailable ? (
              <button
                type="button"
                onClick={() => void toggleRec()}
                disabled={busy || transcribing}
                aria-label={recording ? 'Остановить запись' : 'Записать голос'}
                className={`flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-md active:opacity-90 disabled:opacity-50 ${
                  recording ? 'bg-expense text-white' : 'bg-surface-2 text-ink'
                }`}
              >
                {recording ? <Square size={18} strokeWidth={2} /> : <Mic size={20} strokeWidth={2} />}
              </button>
            ) : null}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!busy) void send();
                }
              }}
              rows={1}
              placeholder={recording ? 'Идёт запись…' : 'Вопрос или команда…'}
              className="num max-h-32 min-h-[44px] flex-1 resize-none rounded-md border border-border bg-surface-2 px-3 py-3 text-[15px] text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy}
              aria-label="Отправить"
              className="flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-accent text-accent-ink shadow-glow active:opacity-90 disabled:opacity-50"
            >
              <SendHorizontal size={20} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ActionCard({
  action,
  busy,
  onDecide,
}: {
  action: AiAssistantAction;
  busy: boolean;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <div className="rounded-md bg-surface-2 p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-faint">
        {TYPE_LABEL[action.command_type] ?? 'Действие'}
      </p>
      <p className="mt-1 text-[15px] text-ink">{action.intent.preview}</p>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(true)}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-pill bg-accent text-[14px] font-semibold text-accent-ink shadow-glow active:opacity-90 disabled:opacity-60"
        >
          <Check size={18} strokeWidth={2.5} />
          Выполнить
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(false)}
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-pill border border-border-strong px-5 text-[14px] text-ink-muted active:bg-surface-3 disabled:opacity-60"
        >
          <X size={18} strokeWidth={2.5} />
          Отмена
        </button>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-line rounded-md bg-accent px-4 py-2 text-[15px] leading-[22px] text-accent-ink">
          {msg.text}
        </div>
      </div>
    );
  }

  if (msg.role === 'error') {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-[90%] whitespace-pre-line rounded-md px-4 py-3 text-[15px] leading-[22px]"
          style={{ background: 'var(--surface-2)', color: 'var(--expense)', border: '1px solid var(--expense)' }}
        >
          {msg.text}
        </div>
      </div>
    );
  }

  const md = msg.text.replace(/^[ \t]*[•‣◦]\s+/gm, '- ');
  return (
    <div className="flex justify-start">
      <div className="md-answer max-w-[90%] rounded-md px-4 py-3" style={{ background: 'var(--surface-2)', color: 'var(--text)' }}>
        <ReactMarkdown
          components={{
            a: ({ href, children }) => (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) openLink(href);
                }}
                style={{ color: 'var(--accent)' }}
              >
                {children}
              </a>
            ),
          }}
        >
          {md}
        </ReactMarkdown>
      </div>
    </div>
  );
}
