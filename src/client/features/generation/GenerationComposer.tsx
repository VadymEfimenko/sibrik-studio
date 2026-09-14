import { ArrowUpRight, Film, LoaderCircle, LockKeyhole, Plus, Sparkles, Zap } from 'lucide-react';
import type { StudioState } from '../../../shared/contracts';
import { credits, number } from '../../lib/format';
import { examples } from './examples';
import { GenerationSettings } from './GenerationSettings';
import { taskNames } from './labels';
import type { useGenerationForm } from './useGenerationForm';

export function GenerationComposer({
  form,
  state,
  loadError,
}: {
  form: ReturnType<typeof useGenerationForm>;
  state: StudioState | null;
  loadError: string;
}) {
  const {
    input,
    setInput,
    prompt,
    setPrompt,
    assetsBusy,
    setAssetsBusy,
    editingJobId,
    importedAsset,
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
    insufficient,
  } = form;
  return (
    <section className="composer" ref={composer} aria-label="Нова генерація">
      <div className="composer-title">
        <span className="section-icon">
          <Sparkles size={17} />
        </span>
        <h2>Нова генерація</h2>
        <span className="text-to-video">{taskNames[input.taskType || 'generate']}</span>
      </div>
      <form onSubmit={generate}>
        <div className="model-choice">
          <div className="model-symbol">
            <Film size={24} />
          </div>
          <div>
            <strong>Seedance 2.5</strong>
            <small>М’який рух. Живі деталі.</small>
          </div>
          <span className="model-dot" title="Доступна" />
        </div>
        {input.taskType === 'edit' &&
          importedAsset &&
          input.references?.[0]?.assetId === importedAsset.id && (
            <div className="edit-source-summary">
              <Film size={18} />
              <div>
                <strong>Редагуємо: {importedAsset.name}</strong>
                <span>
                  {number.format(importedAsset.durationSeconds || 0)} с · Оригінал залишиться у
                  ваших генераціях.
                </span>
                <a href="#edit-references">Переглянути вихідне відео</a>
              </div>
            </div>
          )}
        <div className="label-row">
          <label htmlFor="prompt">
            {input.taskType === 'edit' ? 'Що змінити у відео?' : 'Опишіть сцену'}
          </label>
          <span>Промпт</span>
        </div>
        <div className="prompt-wrap">
          <textarea
            id="prompt"
            ref={promptField}
            maxLength={2000}
            value={prompt}
            disabled={sending || unconfirmed || !!editingJobId}
            onChange={(e) => {
              setPrompt(e.target.value);
              setError('');
            }}
            placeholder={
              input.taskType === 'edit'
                ? 'Опишіть зміни: замініть фон, змініть колір об’єкта або додайте деталь…'
                : 'Що відбувається в кадрі? Додайте рух камери, світло й настрій…'
            }
          />
          <span className="character-count">{prompt.length} / 2000</span>
        </div>
        <div className="examples">
          <span>Почніть з ідеї</span>
          {examples.map((example) => (
            <button
              key={example.name}
              type="button"
              disabled={sending || unconfirmed || !!editingJobId}
              onClick={() => setPrompt(example.prompt)}
            >
              <Plus size={12} />
              {example.name}
            </button>
          ))}
        </div>
        <GenerationSettings
          input={input}
          setInput={setInput}
          disabled={sending || unconfirmed || !!editingJobId}
          importedAsset={importedAsset}
          onAssetsChanged={retryQuote}
          onBusyChange={setAssetsBusy}
        />
        <div className="estimate-box">
          <div>
            <span>Резерв на генерацію</span>
            <strong>
              {quote ? credits(quote.holdMilli) : quoting ? '…' : '—'}
              <Zap size={16} />
            </strong>
          </div>
          <p>
            {quote ? credits(quote.rateMilli) : '—'} кр./с · вхід {quote?.inputSeconds ?? 0} с +
            вихід {quote?.expectedOutputSeconds ?? '—'} с
          </p>
          <p>Очікуване списання: {quote ? credits(quote.estimatedMilli) : '—'} кр.</p>
          <p>
            {quote?.automaticDuration
              ? 'Автоматична тривалість: резервуємо до 30 секунд виходу. Невикористаний резерв повертається.'
              : quote
                ? `Резервуємо ${number.format(quote.reservedOutputSeconds)} с виходу, включно з 1 с запасу. Списання за фактичною тривалістю, залишок повертається.`
                : 'Остаточний розрахунок за перевіреною тривалістю файлів.'}
          </p>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {quoteError && (
          <p className="form-error" role="alert">
            {quoteError}{' '}
            <button type="button" className="text-retry" onClick={retryQuote}>
              Повторити розрахунок
            </button>
          </p>
        )}
        {insufficient && !unconfirmed && (
          <p className="form-error">
            Не вистачає {credits(quote!.holdMilli - state!.wallet.availableMilli)} кредиту.
            Зачекайте на повернення резерву або виберіть меншу тривалість.
          </p>
        )}
        <button
          className="generate"
          type="submit"
          disabled={
            sending ||
            assetsBusy ||
            !!editingJobId ||
            !state ||
            (!unconfirmed && (!quote || insufficient || !!loadError))
          }
        >
          {sending ? (
            <LoaderCircle className="spin" size={19} />
          ) : (
            <Zap size={18} fill="currentColor" />
          )}
          {sending
            ? 'Додаємо до черги…'
            : unconfirmed
              ? 'Повторити запит'
              : input.taskType === 'edit'
                ? 'Відредагувати відео'
                : 'Згенерувати відео'}
          {!sending && <ArrowUpRight size={18} />}
        </button>
        <p className="billing-note">
          <LockKeyhole size={12} />
          Списання після готовності. Залишок повернеться.
        </p>
      </form>
    </section>
  );
}
