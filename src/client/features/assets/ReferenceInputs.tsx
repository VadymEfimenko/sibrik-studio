import { Upload, X } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { AssetKind, GenerateInput } from '../../../shared/contracts';
import { FrameMarkup } from './FrameMarkup';
import type { useAssetLibrary } from './useAssetLibrary';
const assetStates = {
  local: 'Очікує підготовки',
  processing: 'Перевірка APIMart',
  ready: 'Готовий',
  failed: 'Не вдалося',
};
const kindNames = { image: 'Зображення', video: 'Відео', audio: 'Аудіо' };

export function ReferenceInputs({
  setInput,
  libraryState,
}: {
  setInput: Dispatch<SetStateAction<GenerateInput>>;
  libraryState: ReturnType<typeof useAssetLibrary>;
}) {
  const {
    assets,
    busy,
    setBusy,
    setError,
    localReady,
    url,
    setUrl,
    urlKind,
    setUrlKind,
    library,
    setLibrary,
    mode,
    selected,
    source,
    add,
    upload,
    uploadFiles,
    importUrl,
    retryAsset,
  } = libraryState;
  return (
    <>
      {mode !== 'generate' && (
        <div className="reference-panel" id="edit-references">
          <h3>
            {mode === 'frames'
              ? 'Перший та останній кадр'
              : mode === 'edit' || mode === 'extend'
                ? 'Вихідне відео та референси'
                : 'Референси'}
          </h3>
          <p className="option-hint">
            {mode === 'edit'
              ? 'Додайте відео 4–30 с і опишіть зміни. Перший відеореференс — джерело редагування.'
              : mode === 'frames'
                ? 'Одне зображення для першого кадру, друге — для останнього.'
                : mode === 'extend'
                  ? 'Додайте відео й опишіть, як продовжити його вперед або назад.'
                  : 'Зображення задають вигляд, відео — рух, аудіо — звук. Можна поєднувати матеріали.'}
          </p>
          <label className="upload-control">
            <Upload size={16} />
            {busy ? 'Завантаження…' : 'Додати файли'}
            <input
              type="file"
              multiple
              accept={
                mode === 'frames'
                  ? 'image/png,image/jpeg,image/webp,image/gif'
                  : 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,audio/mpeg,audio/wav'
              }
              onChange={(e) => {
                void uploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <p className="option-hint">
            Зображення до 20 MB · відео до 200 MB · аудіо до 15 MB. Файли передаються в APIMart для
            використання в генерації.
          </p>
          {!localReady && (
            <p className="asset-notice">
              Локальні відео й аудіо потребують адреси тунелю MEDIA_BASE_URL. Поки можна імпортувати
              пряме HTTPS-посилання. Зображення завантажуються без тунелю.
            </p>
          )}
          <details className="url-import">
            <summary>Імпортувати за посиланням</summary>
            <label>
              Тип
              <select value={urlKind} onChange={(e) => setUrlKind(e.target.value as AssetKind)}>
                {Object.entries(kindNames).map(([kind, name]) => (
                  <option key={kind} value={kind}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="url"
              aria-label="Посилання на референс"
              placeholder="https://…/video.mp4"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="button" disabled={!url || busy} onClick={() => void importUrl()}>
              Імпортувати
            </button>
          </details>
          {!!assets.length && (
            <div className="library-select">
              <select
                aria-label="Бібліотека референсів"
                value={library}
                onChange={(e) => setLibrary(e.target.value)}
              >
                <option value="">Вибрати з бібліотеки…</option>
                {assets
                  .filter(
                    (a) =>
                      !selected.some((s) => s.assetId === a.id) &&
                      (mode !== 'frames' || a.kind === 'image'),
                  )
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {assetStates[a.status]}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={!library}
                onClick={() => {
                  const a = assets.find((a) => a.id === library);
                  if (a) add(a);
                  setLibrary('');
                }}
              >
                Додати
              </button>
            </div>
          )}
          <div className="selected-assets">
            {selected.map((reference, index) => {
              const asset = assets.find((a) => a.id === reference.assetId);
              const count = asset
                ? selected
                    .slice(0, index + 1)
                    .filter((s) => assets.find((a) => a.id === s.assetId)?.kind === asset.kind)
                    .length
                : 0;
              return (
                <div className="selected-asset" key={reference.assetId}>
                  {asset?.kind === 'image' ? (
                    <img src={asset.previewUrl} alt={asset.name} />
                  ) : asset?.kind === 'video' ? (
                    <video src={asset.previewUrl} controls preload="metadata" />
                  ) : asset?.kind === 'audio' ? (
                    <audio src={asset.previewUrl} controls preload="metadata" />
                  ) : null}
                  <div className="asset-caption">
                    <strong>{asset?.name || 'Завантаження референсу…'}</strong>
                    <button
                      type="button"
                      aria-label="Прибрати референс"
                      onClick={() =>
                        setInput((old) => ({
                          ...old,
                          references: old.references?.filter(
                            (r) => r.assetId !== reference.assetId,
                          ),
                        }))
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {asset && (
                    <>
                      <small>
                        {mode === 'frames'
                          ? reference.role === 'first_frame'
                            ? 'Перший кадр'
                            : 'Останній кадр'
                          : `@${{ image: '图片', video: '视频', audio: '音频' }[asset.kind]}${count}`}{' '}
                        · {asset.durationSeconds ? `${asset.durationSeconds} с · ` : ''}
                        {assetStates[asset.status]}
                      </small>
                      {asset.error && <p className="asset-notice">{asset.error}</p>}
                      {(asset.status === 'failed' || asset.status === 'local') && (
                        <button
                          type="button"
                          className="text-retry"
                          onClick={() => retryAsset(asset.id)}
                        >
                          Повторити підготовку
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {mode === 'edit' && source && (
            <FrameMarkup
              key={source.id}
              source={source}
              imageNumber={
                selected.filter((s) => assets.find((a) => a.id === s.assetId)?.kind === 'image')
                  .length + 1
              }
              upload={upload}
              setInput={setInput}
              setBusy={setBusy}
              setError={setError}
            />
          )}
        </div>
      )}
    </>
  );
}
