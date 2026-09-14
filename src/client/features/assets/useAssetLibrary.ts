import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AssetKind, GenerateInput, StudioAsset } from '../../../shared/contracts';
export interface AssetLibraryOptions {
  input: GenerateInput;
  setInput: Dispatch<SetStateAction<GenerateInput>>;
  onAssetsChanged: () => void;
  onBusyChange: (busy: boolean) => void;
  importedAsset: StudioAsset | null;
}
export function useAssetLibrary({
  input,
  setInput,
  onAssetsChanged,
  onBusyChange,
  importedAsset,
}: AssetLibraryOptions) {
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  const [error, setError] = useState('');
  const [localReady, setLocalReady] = useState(true);
  const [url, setUrl] = useState('');
  const [urlKind, setUrlKind] = useState<AssetKind>('video');
  const [library, setLibrary] = useState('');
  const revision = useRef('');
  const mode = input.taskType || 'generate';
  const selected = input.references || [];
  const source = selected
    .map((s) => assets.find((a) => a.id === s.assetId))
    .find((a) => a?.kind === 'video');
  const callback = useRef(onAssetsChanged);
  callback.current = onAssetsChanged;
  useEffect(() => {
    if (importedAsset) {
      setAssets((old) => [importedAsset, ...old.filter((a) => a.id !== importedAsset.id)]);
      setError('');
    }
  }, [importedAsset]);
  useEffect(() => {
    if (mode === 'generate') return;
    let stopped = false;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const data = await responseJson<{ assets: StudioAsset[]; localMediaReady: boolean }>(
          await fetch('/api/assets', { signal: AbortSignal.timeout(10000) }),
        );
        if (stopped) return;
        setAssets(
          importedAsset && !data.assets.some((a: StudioAsset) => a.id === importedAsset.id)
            ? [importedAsset, ...data.assets]
            : data.assets,
        );
        setLocalReady(data.localMediaReady);
        const next = JSON.stringify(data.assets.map((a: StudioAsset) => [a.id, a.status]));
        if (next !== revision.current) {
          revision.current = next;
          callback.current();
        }
      } catch {
        if (!stopped) setError('Не вдалося оновити бібліотеку. Перевірте з’єднання.');
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mode, importedAsset]);
  function add(asset: StudioAsset) {
    setAssets((old) => [asset, ...old.filter((a) => a.id !== asset.id)]);
    setInput((old) => {
      const refs = old.references || [];
      if (refs.some((r) => r.assetId === asset.id)) return old;
      return {
        ...old,
        references: [
          ...refs,
          {
            assetId: asset.id,
            role:
              old.taskType === 'frames'
                ? refs.length
                  ? 'last_frame'
                  : 'first_frame'
                : 'reference',
          },
        ],
      };
    });
  }
  async function upload(file: File) {
    const kind: AssetKind = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'video';
    const query = new URLSearchParams({ name: file.name, kind });
    const asset = await responseJson<StudioAsset>(
      await fetch(`/api/assets/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        signal: AbortSignal.timeout(120000),
      }),
    );
    add(asset);
    return asset;
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError('');
    try {
      for (const file of Array.from(files)) await upload(file);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importUrl() {
    setBusy(true);
    setError('');
    try {
      add(
        await responseJson<StudioAsset>(
          await fetch('/api/assets/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, kind: urlKind, name: 'Референс за посиланням' }),
            signal: AbortSignal.timeout(90000),
          }),
        ),
      );
      setUrl('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function retryAsset(id: string) {
    void fetch(`/api/assets/${id}/retry`, { method: 'POST' })
      .then(responseJson<StudioAsset>)
      .then((a) => setAssets((old) => old.map((x) => (x.id === a.id ? a : x))))
      .catch((e: Error) => setError(e.message));
  }
  return {
    assets,
    busy,
    setBusy,
    error,
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
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Не вдалося виконати запит.');
  return result as T;
}
