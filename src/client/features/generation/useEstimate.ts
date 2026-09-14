import { useCallback, useEffect, useState } from 'react';
import type { Estimate, GenerateInput } from '../../../shared/contracts';
export function useEstimate(input: GenerateInput) {
  const prompt = input.prompt;
  const [quote, setQuote] = useState<Estimate | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [quoteRevision, setQuoteRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setQuote(null);
    setQuoteError('');
    if (prompt.trim().length < 3) {
      setQuoting(false);
      return () => controller.abort();
    }
    setQuoting(true);
    const timer = setTimeout(() => {
      void fetch('/api/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, prompt: prompt.trim() }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok)
            throw new Error(value.error?.message || 'Не вдалося розрахувати резерв.');
          if (!controller.signal.aborted) setQuote(value);
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setQuoteError(e.message || 'Не вдалося розрахувати резерв.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setQuoting(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, quoteRevision]);
  const retryQuote = useCallback(() => setQuoteRevision((v) => v + 1), []);
  const clearQuote = useCallback(() => {
    setQuote(null);
    setQuoteError('');
  }, []);
  return { quote, quoting, quoteError, retryQuote, clearQuote };
}
