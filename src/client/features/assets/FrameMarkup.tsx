import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { GenerateInput, StudioAsset } from '../../../shared/contracts';
export function FrameMarkup({
  source,
  imageNumber,
  upload,
  setInput,
  setBusy,
  setError,
}: {
  source: StudioAsset;
  imageNumber: number;
  upload: (file: File) => Promise<StudioAsset>;
  setInput: Dispatch<SetStateAction<GenerateInput>>;
  setBusy: (b: boolean) => void;
  setError: (s: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [captured, setCaptured] = useState(false);
  const [time, setTime] = useState(0);
  const drawing = useRef(false);
  function capture() {
    const v = video.current,
      c = canvas.current;
    if (!v || !c || v.readyState < 2) return;
    v.pause();
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    setTime(v.currentTime);
    setCaptured(true);
  }
  async function save() {
    const c = canvas.current;
    if (!c) return;
    setBusy(true);
    setError('');
    try {
      const blob = await new Promise<Blob>((resolve, reject) =>
        c.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Не вдалося зберегти кадр.'))),
          'image/png',
        ),
      );
      await upload(new File([blob], `mark-${time.toFixed(2)}s.png`, { type: 'image/png' }));
      setInput((old) => ({
        ...old,
        prompt: (
          old.prompt +
          `\nUse the red-marked image @图片${imageNumber} as a visual guide to the target area in @视频1 at ${time.toFixed(2)} seconds. Do not include the red markings in the result.`
        ).slice(0, 2000),
      }));
      setCaptured(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="frame-markup">
      <summary>Позначити область на кадрі</summary>
      <p className="option-hint">
        Виберіть момент, збережіть кадр і позначте область червоною кистю. Це зображення-підказка
        для моделі; точне збереження решти кадру не гарантується.
      </p>
      <video ref={video} src={source.previewUrl} controls preload="metadata" />
      <button type="button" onClick={capture}>
        Взяти поточний кадр
      </button>
      <canvas
        ref={canvas}
        hidden={!captured}
        onPointerDown={(e) => {
          const c = canvas.current!,
            ctx = c.getContext('2d')!,
            r = c.getBoundingClientRect();
          drawing.current = true;
          c.setPointerCapture(e.pointerId);
          ctx.beginPath();
          ctx.moveTo(
            ((e.clientX - r.left) * c.width) / r.width,
            ((e.clientY - r.top) * c.height) / r.height,
          );
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const c = canvas.current!,
            ctx = c.getContext('2d')!,
            r = c.getBoundingClientRect();
          ctx.strokeStyle = 'rgba(255,35,45,0.85)';
          ctx.lineWidth = Math.max(5, c.width / 90);
          ctx.lineCap = 'round';
          ctx.lineTo(
            ((e.clientX - r.left) * c.width) / r.width,
            ((e.clientY - r.top) * c.height) / r.height,
          );
          ctx.stroke();
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      />
      {captured && (
        <button type="button" onClick={() => void save()}>
          Додати позначений кадр
        </button>
      )}
    </details>
  );
}
