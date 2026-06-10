import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from './api';

export type AsyncStatus = 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  error: string | null;
  reload: () => void;
}

/**
 * Загружает данные через переданную фабрику промиса.
 * Перезапрашивает при изменении deps. Отменяет устаревшие ответы.
 */
export function useAsync<T>(factory: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const run = useCallback(() => {
    const id = ++reqId.current;
    setStatus('loading');
    setError(null);
    factory()
      .then((result) => {
        if (id !== reqId.current) return;
        setData(result);
        setStatus('success');
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        const message =
          err instanceof ApiClientError ? err.message : 'Не удалось загрузить данные.';
        setError(message);
        setStatus('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { status, data, error, reload: run };
}
