import type { Dispatch, SetStateAction } from 'react';
import {
  aspectRatios,
  resolutions,
  type GenerateInput,
  type TaskType,
} from '../../../shared/contracts';
import { taskNames } from './labels';
export function GenerationOptions({
  input,
  setInput,
}: {
  input: GenerateInput;
  setInput: Dispatch<SetStateAction<GenerateInput>>;
}) {
  const mode = input.taskType || 'generate';
  return (
    <>
      <label className="control-label" htmlFor="task-type">
        Режим
      </label>
      <select
        id="task-type"
        value={mode}
        onChange={(e) => {
          const taskType = e.target.value as TaskType;
          setInput((old) => ({
            ...old,
            taskType,
            size: ['edit', 'extend', 'frames'].includes(taskType) ? 'adaptive' : '16:9',
            duration: taskType === 'edit' ? -1 : old.taskType === 'edit' ? 4 : old.duration,
            references:
              taskType === 'generate' || taskType === 'frames'
                ? []
                : (old.references || []).map((r) => ({ ...r, role: 'reference' })),
          }));
        }}
      >
        {Object.entries(taskNames).map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
      <div className="option-grid">
        <label>
          Якість
          <select
            aria-label="Якість"
            value={input.resolution}
            onChange={(e) =>
              setInput((old) => ({
                ...old,
                resolution: e.target.value as GenerateInput['resolution'],
              }))
            }
          >
            {resolutions.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          Тривалість
          <select
            aria-label="Тривалість"
            value={input.duration}
            disabled={mode === 'edit'}
            onChange={(e) => setInput((old) => ({ ...old, duration: Number(e.target.value) }))}
          >
            <option value={-1}>{mode === 'edit' ? 'Як у джерела' : 'Автоматично (до 30 с)'}</option>
            {Array.from({ length: 27 }, (_, i) => i + 4).map((d) => (
              <option key={d} value={d}>
                {d} с
              </option>
            ))}
          </select>
        </label>
        <label>
          Пропорції
          <select
            aria-label="Пропорції"
            value={input.size || '16:9'}
            disabled={['edit', 'extend', 'frames'].includes(mode)}
            onChange={(e) =>
              setInput((old) => ({ ...old, size: e.target.value as GenerateInput['size'] }))
            }
          >
            {aspectRatios.map((r) => (
              <option key={r} value={r}>
                {r === 'adaptive' ? 'За референсом' : r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Формат
          <select
            aria-label="Формат"
            value={input.outputFormat || 'mp4'}
            onChange={(e) =>
              setInput((old) => ({ ...old, outputFormat: e.target.value as 'mp4' | 'mov' }))
            }
          >
            <option value="mp4">MP4</option>
            <option value="mov">MOV</option>
          </select>
        </label>
      </div>
      <div className="toggle-row">
        <label>
          <input
            type="checkbox"
            checked={input.generateAudio ?? true}
            onChange={(e) => setInput((old) => ({ ...old, generateAudio: e.target.checked }))}
          />
          Зі звуком
        </label>
        <label>
          <input
            type="checkbox"
            checked={input.watermark ?? false}
            onChange={(e) => setInput((old) => ({ ...old, watermark: e.target.checked }))}
          />
          Водяний знак
        </label>
      </div>
      <details className="advanced-options">
        <summary>Додатково</summary>
        <label>
          Seed (необов’язково)
          <input
            type="number"
            min="0"
            max="2147483647"
            step="1"
            placeholder="Випадковий"
            value={input.seed ?? ''}
            onChange={(e) =>
              setInput((old) => ({
                ...old,
                seed: e.target.value === '' ? undefined : Number(e.target.value),
              }))
            }
          />
        </label>
      </details>
    </>
  );
}
