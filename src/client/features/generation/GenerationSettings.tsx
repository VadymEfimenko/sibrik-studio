import { LoaderCircle } from 'lucide-react';
import { ReferenceInputs } from '../assets/ReferenceInputs';
import { useAssetLibrary, type AssetLibraryOptions } from '../assets/useAssetLibrary';
import { GenerationOptions } from './GenerationOptions';
export function GenerationSettings({
  disabled,
  ...options
}: AssetLibraryOptions & { disabled: boolean }) {
  const libraryState = useAssetLibrary(options);
  const { busy, error } = libraryState;
  return (
    <fieldset className="generation-settings" disabled={disabled || busy}>
      <GenerationOptions input={options.input} setInput={options.setInput} />
      <ReferenceInputs setInput={options.setInput} libraryState={libraryState} />
      {busy && (
        <p className="option-hint">
          <LoaderCircle size={12} className="spin" /> Завантажуємо і перевіряємо файл…
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
