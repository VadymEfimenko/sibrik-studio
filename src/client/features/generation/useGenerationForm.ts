import { useRef, useState } from 'react';
import type {
  GenerateInput,
  GenerationJob,
  StudioAsset,
  StudioState,
} from '../../../shared/contracts';
import { useEstimate } from './useEstimate';
type Attempt = { key: string; input: GenerateInput };
function restoredAttempt(): Attempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem('sibrik-pending') || 'null');
    return value?.key && value?.input?.prompt ? value : null;
  } catch {
    return null;
  }
}

export function useGenerationForm({
  state,
  refresh,
  onNotice,
  onSubmitted,
}: {
  state: StudioState | null;
  refresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onSubmitted: () => void;
}) {
  const [restored] = useState(restoredAttempt);
  const [input, setInput] = useState<GenerateInput>(
    restored?.input || {
      modelId: 'seedance-2.5',
      prompt: '',
      duration: 4,
      resolution: '480p',
      taskType: 'generate',
      size: '16:9',
      outputFormat: 'mp4',
      generateAudio: true,
      references: [],
    },
  );
  const prompt = input.prompt;
  const setPrompt = (prompt: string) => setInput((old) => ({ ...old, prompt }));
  const [assetsBusy, setAssetsBusy] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [importedAsset, setImportedAsset] = useState<StudioAsset | null>(null);
  const [editError, setEditError] = useState<{ jobId: string; message: string } | null>(null);
  const editPending = useRef(false);
  const composer = useRef<HTMLElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const { quote, quoting, quoteError, retryQuote, clearQuote } = useEstimate(input);
  const [sending, setSending] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(!!restored);
  const attempt = useRef<Attempt | null>(restored);
  const [error, setError] = useState(
    restored ? 'Попередній запит не підтверджено. Повторіть його з тим самим ключем.' : '',
  );
  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (sending || assetsBusy || editPending.current || !state) return;
    const current = attempt.current || {
      key: crypto.randomUUID(),
      input: { ...input, prompt: prompt.trim() },
    };
    attempt.current = current;
    sessionStorage.setItem('sibrik-pending', JSON.stringify(current));
    setUnconfirmed(true);
    setSending(true);
    setError('');
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': current.key },
        body: JSON.stringify(current.input),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) {
          attempt.current = null;
          sessionStorage.removeItem('sibrik-pending');
          setUnconfirmed(false);
        }
        throw new Error(result.error?.message || 'Сервер не підтвердив запит. Повторіть його.');
      }
      attempt.current = null;
      sessionStorage.removeItem('sibrik-pending');
      setUnconfirmed(false);
      onNotice('Генерацію додано. Кредити зарезервовано.');
      onSubmitted();
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error && !['TimeoutError', 'TypeError'].includes(error.name)
          ? error.message
          : 'Відповіді не отримано. Повторіть запит — повторного резервування не буде.',
      );
    } finally {
      setSending(false);
    }
  }
  async function editVideo(job: GenerationJob) {
    if (sending || unconfirmed || assetsBusy || editPending.current) return;
    editPending.current = true;
    setEditingJobId(job.id);
    setEditError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/edit-source`, {
        method: 'POST',
        signal: AbortSignal.timeout(60000),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || 'Не вдалося вибрати відео для редагування.');
      const source = result as StudioAsset;
      setImportedAsset(source);
      setInput({
        modelId: 'seedance-2.5',
        prompt: '',
        taskType: 'edit',
        duration: -1,
        size: 'adaptive',
        resolution: state?.model.resolutions.includes(job.resolution as GenerateInput['resolution'])
          ? (job.resolution as GenerateInput['resolution'])
          : '480p',
        outputFormat: job.outputFormat || 'mp4',
        generateAudio: true,
        references: [{ assetId: source.id, role: 'reference' }],
      });
      clearQuote();
      setError('');
      onNotice('Відео додано до редагування. Опишіть, що змінити.');
      requestAnimationFrame(() => {
        composer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        promptField.current?.focus({ preventScroll: true });
      });
    } catch (error) {
      setEditError({
        jobId: job.id,
        message:
          error instanceof Error && !['TimeoutError', 'TypeError'].includes(error.name)
            ? error.message
            : 'Не вдалося підготувати відео. Спробуйте ще раз.',
      });
    } finally {
      editPending.current = false;
      setEditingJobId(null);
    }
  }
  const insufficient = !!(state && quote && quote.holdMilli > state.wallet.availableMilli);
  return {
    input,
    setInput,
    prompt,
    setPrompt,
    assetsBusy,
    setAssetsBusy,
    editingJobId,
    importedAsset,
    editError,
    composer,
    promptField,
    quote,
    quoting,
    quoteError,
    retryQuote,
    sending,
    unconfirmed,
    error,
    setError,
    generate,
    editVideo,
    insufficient,
  };
}
