/**
 * Вкладка «AI» — единый ассистент: отвечает как наставник (аналитика, советы)
 * И выполняет действия оркестратора (счёт, расчёт налога, переклассификация),
 * плюс голосовая диктовка. POST /api/ai/assistant → answer | action.
 */

import { useRef, useState, type ChangeEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { SendHorizontal, Sparkles, Trash2, Mic, Square, Check, X, ImagePlus } from 'lucide-react';
import { Header } from '../components/Header';
import { useApp, useFilters, type ChatMessage } from '../state/FilterContext';
import { api, ApiClientError } from '../lib/api';
import { rubles } from '../lib/money';
import { openLink } from '../lib/telegram';
import type { AiAssistantAction, ImportedTxItem } from '../lib/types';

/** Загрузка картинки в <img> из File. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

/** Сжимает фото (JPEG, до 1500px) → base64 без префикса, чтобы влезть в лимит тела. */
async function fileToCompressedBase64(file: File): Promise<{ base64: string; mime: string }> {
  const img = await loadImage(file);
  const scale = Math.min(1, 1500 / img.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
  URL.revokeObjectURL(img.src);
  return { base64: dataUrl.split(',')[1] ?? '', mime: 'image/jpeg' };
}

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

  // Импорт по скриншоту карты
  const [pendingImport, setPendingImport] = useState<ImportedTxItem[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPending(null);
    setPendingImport(null);
    addChatMessage({ role: 'user', text: '📷 Скриншот выписки' });
    setScanning(true);
    try {
      const { base64, mime } = await fileToCompressedBase64(file);
      const res = await api.importImage(base64, mime);
      if (res.ok && res.transactions && res.transactions.length > 0) {
        setPendingImport(res.transactions);
      } else {
        addChatMessage({ role: 'error', text: res.error ?? 'Не удалось распознать операции на скриншоте.' });
      }
    } catch {
      addChatMessage({ role: 'error', text: 'Не удалось обработать изображение.' });
    } finally {
      setScanning(false);
    }
  }

  async function confirmImport(ok: boolean) {
    if (!pendingImport) return;
    if (!ok) {
      setPendingImport(null);
      addChatMessage({ role: 'assistant', text: 'Отменено.' });
      return;
    }
    setBusy(true);
    try {
      const res = await api.importConfirm(pendingImport, 'lilia');
      if (res.ok) {
        addChatMessage({
          role: 'assistant',
          text: `✅ Занесено операций: ${res.created} (в ФОТ: ${res.payroll}). Пропущено дублей: ${res.skipped}. Сумма: ${rubles(res.total ?? 0)}.`,
        });
      } else {
        addChatMessage({ role: 'error', text: res.error ?? 'Не удалось занести операции.' });
      }
    } catch {
      addChatMessage({ role: 'error', text: 'Ошибка при занесении операций.' });
    } finally {
      setPendingImport(null);
      setBusy(false);
    }
  }

  async function send() {
    const question = input.trim();
    if (question.length === 0) {
      addChatMessage({ role: 'error', text: ERROR_HINTS['invalid_request']! });
      return;
    }
    // История диалога (последние 6 сообщений) — чтобы follow-up «формируй»/«исправь»
    // понимались по контексту.
    const history = chatMessages
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Пользователь' : 'AI'}: ${m.text}`)
      .join('\n');
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
        history: history || null,
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
                Голосом 🎤 или пришли 📷 скриншот выписки карты — распознаю и занесу операции.
              </p>
            </div>
          ) : (
            chatMessages.map((m) => <Bubble key={m.id} msg={m} />)
          )}
          {pending ? <ActionCard action={pending} busy={busy} onDecide={decide} /> : null}
          {pendingImport ? <ImportCard txs={pendingImport} busy={busy} onDecide={confirmImport} /> : null}
          {busy && !pending && !pendingImport ? <div className="text-[13px] text-ink-faint">AI печатает…</div> : null}
          {transcribing ? <div className="text-[13px] text-ink-faint">Распознаю речь…</div> : null}
          {scanning ? <div className="text-[13px] text-ink-faint">Распознаю скриншот…</div> : null}
        </div>

        <div className="safe-bottom sticky bottom-0 bg-bg-deep pt-2 pb-[calc(72px+env(safe-area-inset-bottom,0px))]">
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void onPickImage(e)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy || scanning}
              aria-label="Прикрепить скриншот выписки"
              className="flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-surface-2 text-ink active:opacity-90 disabled:opacity-50"
            >
              <ImagePlus size={20} strokeWidth={2} />
            </button>
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

function ImportCard({
  txs,
  busy,
  onDecide,
}: {
  txs: ImportedTxItem[];
  busy: boolean;
  onDecide: (ok: boolean) => void;
}) {
  const totalOut = txs.reduce((s, t) => s + (t.direction === 'out' ? t.amount_rub : 0), 0);
  return (
    <div className="rounded-md bg-surface-2 p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-ink-faint">
        Распознано со скриншота · {txs.length} операц.
      </p>
      <ul className="mt-2 max-h-64 divide-y divide-border overflow-y-auto">
        {txs.map((t, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink">
                {t.counterparty || t.description || 'Операция'}
              </span>
              <span className="num block text-[11px] text-ink-faint">
                {t.date}
                {t.direction === 'in' ? ' · поступление' : ''}
              </span>
            </span>
            <span
              className="num shrink-0 text-[13px] font-semibold"
              style={{ color: t.direction === 'out' ? 'var(--expense)' : 'var(--income)' }}
            >
              {t.direction === 'out' ? '−' : '+'}
              {rubles(Math.round(t.amount_rub * 100))}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-ink-muted">Итого трат: {rubles(Math.round(totalOut * 100))}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(true)}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-pill bg-accent text-[14px] font-semibold text-accent-ink shadow-glow active:opacity-90 disabled:opacity-60"
        >
          <Check size={18} strokeWidth={2.5} />
          Занести
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
