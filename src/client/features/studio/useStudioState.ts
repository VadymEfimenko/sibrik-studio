import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioState } from '../../../shared/contracts';
export function useStudioState() {
  const [state, setState] = useState<StudioState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [connected, setConnected] = useState(false);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const response = await fetch('/api/state', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const value = (await response.json()) as StudioState;
      if (sequence === refreshSequence.current) {
        setState(value);
        setLoadError('');
      }
    } catch {
      if (sequence === refreshSequence.current)
        setLoadError('Немає зв’язку із сервером. Дані оновляться після відновлення з’єднання.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const stream = new EventSource('/api/events');
    stream.onopen = () => {
      setConnected(true);
      void refresh();
    };
    stream.onerror = () => setConnected(false);
    stream.addEventListener('resync', () => {
      void refresh();
    });
    stream.addEventListener('changed', () => {
      void refresh();
    });
    // Periodic reconciliation also covers a lost NOTIFY during a database reconnect.
    const fallback = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15000);
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      stream.close();
      clearInterval(fallback);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  return { state, loadError, connected, refresh };
}
