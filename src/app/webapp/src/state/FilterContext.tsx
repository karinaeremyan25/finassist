/**
 * Глобальный фильтр-стейт + данные сессии.
 * entity_id, direction_id, period{from,to} — общие для всех экранов.
 * Фильтры шлют запросы на сервер, экран рендерит ответ.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiClientError } from '../lib/api';
import type { Period, SessionEntity, SessionResponse } from '../lib/types';

interface FilterState {
  entityId: string | null;
  directionId: string | null;
  period: Period;
}

/** Сообщение чата AI-наставника. Живёт в контексте, переживает навигацию. */
export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
}

interface AppContextValue extends FilterState {
  sessionLoading: boolean;
  sessionError: string | null;
  session: SessionResponse | null;
  entities: SessionEntity[];
  directions: SessionEntity[];
  setEntity: (id: string | null) => void;
  setDirection: (id: string | null) => void;
  setPeriod: (period: Period) => void;
  retrySession: () => void;
  /** История чата AI-наставника — сохраняется между вкладками. */
  chatMessages: ChatMessage[];
  addChatMessage: (msg: Omit<ChatMessage, 'id'>) => void;
  clearChat: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const FALLBACK_PERIOD: Period = (() => {
  const d = new Date();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
})();

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [entityId, setEntityId] = useState<string | null>(null);
  const [directionId, setDirectionId] = useState<string | null>(null);
  const [period, setPeriodState] = useState<Period>(FALLBACK_PERIOD);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatNextId = useRef(1);

  const addChatMessage = useCallback((msg: Omit<ChatMessage, 'id'>) => {
    setChatMessages((prev) => [...prev, { ...msg, id: chatNextId.current++ }]);
  }, []);
  const clearChat = useCallback(() => setChatMessages([]), []);

  const loadSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const data = await api.session();
      setSession(data);
      if (data.defaultPeriod) setPeriodState(data.defaultPeriod);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : 'Не удалось распознать сессию Telegram.';
      setSessionError(message);
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const value = useMemo<AppContextValue>(
    () => ({
      entityId,
      directionId,
      period,
      sessionLoading,
      sessionError,
      session,
      entities: session?.entities ?? [],
      directions: session?.availableDirections ?? [],
      setEntity: setEntityId,
      setDirection: setDirectionId,
      setPeriod: setPeriodState,
      retrySession: () => void loadSession(),
      chatMessages,
      addChatMessage,
      clearChat,
    }),
    [
      entityId,
      directionId,
      period,
      sessionLoading,
      sessionError,
      session,
      loadSession,
      chatMessages,
      addChatMessage,
      clearChat,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

/** Удобный хук фильтров для запросов. */
export function useFilters(): { period: Period; entity_id: string | null; direction_id: string | null } {
  const { period, entityId, directionId } = useApp();
  return { period, entity_id: entityId, direction_id: directionId };
}
