/** AIChatWidget = вкладка «Чат». Шлёт POST /api/ai-chat, рендерит answer (markdown). */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { SendHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { Header } from '../components/Header';
import { useApp, useFilters, type ChatMessage } from '../state/FilterContext';
import { api, ApiClientError } from '../lib/api';
import { openLink } from '../lib/telegram';

const ERROR_HINTS: Record<string, string> = {
  off_topic: 'Я отвечаю только на вопросы про финансы и аналитику этого бизнеса.',
  insufficient_data: 'Недостаточно данных за выбранный период. Попробуйте расширить период.',
  ai_unavailable: 'AI-наставник временно недоступен. Попробуйте позже.',
  invalid_request: 'Вопрос не может быть пустым.',
  network_error: 'Нет соединения с сервером.',
};

export function Chat() {
  const { period, entity_id } = useFilters();
  const { chatMessages, addChatMessage, clearChat } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    const question = input.trim();
    if (question.length === 0) {
      pushError('invalid_request');
      return;
    }
    setInput('');
    addChatMessage({ role: 'user', text: question });
    setBusy(true);
    try {
      const res = await api.aiChat({
        question,
        entity_id,
        from: period.from,
        to: period.to,
        context: 'dashboard',
      });
      addChatMessage({ role: 'assistant', text: res.answer });
    } catch (err) {
      const code = err instanceof ApiClientError ? err.code : 'network_error';
      const msg =
        err instanceof ApiClientError && !ERROR_HINTS[code] ? err.message : ERROR_HINTS[code];
      addChatMessage({ role: 'error', text: msg ?? 'Ошибка запроса.' });
    } finally {
      setBusy(false);
    }
  }

  function pushError(code: string) {
    addChatMessage({ role: 'error', text: ERROR_HINTS[code] ?? 'Ошибка.' });
  }

  return (
    <>
      <Header />
      <div className="flex flex-col px-4 -mt-2" style={{ minHeight: 'calc(100vh - 140px)' }}>
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-[22px] font-semibold text-ink">AI-наставник</h1>
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
          {chatMessages.length === 0 ? (
            <div className="rounded-md bg-surface-2 p-4">
              <div className="mb-1 flex items-center gap-2 text-accent">
                <Sparkles size={16} strokeWidth={2} />
                <span className="text-[15px] font-semibold text-ink">Спросите о финансах</span>
              </div>
              <p className="text-[13px] leading-[18px] text-ink-muted">
                Например: «Почему налоговый фонд ниже нормы?» или «Какие расходы можно сократить?»
              </p>
            </div>
          ) : (
            chatMessages.map((m) => <Bubble key={m.id} msg={m} />)
          )}
          {busy ? (
            <div className="text-[13px] text-ink-faint">AI-наставник печатает…</div>
          ) : null}
        </div>

        <div className="safe-bottom sticky bottom-0 bg-bg-deep pt-2 pb-[calc(72px+env(safe-area-inset-bottom,0px))]">
          <div className="flex items-end gap-2">
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
              placeholder="Ваш вопрос…"
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

  const isError = msg.role === 'error';

  if (isError) {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-[90%] whitespace-pre-line rounded-md px-4 py-3 text-[15px] leading-[22px]"
          style={{
            background: 'var(--surface-2)',
            color: 'var(--expense)',
            border: '1px solid var(--expense)',
          }}
        >
          {msg.text}
        </div>
      </div>
    );
  }

  // Ассистент: рендерим markdown.
  // Нормализуем буллеты «• » → «- », чтобы они стали настоящими списками.
  const md = msg.text.replace(/^[ \t]*[•‣◦]\s+/gm, '- ');
  return (
    <div className="flex justify-start">
      <div
        className="md-answer max-w-[90%] rounded-md px-4 py-3"
        style={{ background: 'var(--surface-2)', color: 'var(--text)' }}
      >
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
