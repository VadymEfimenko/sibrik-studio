import { spawn } from 'node:child_process';
import type { AssetKind } from '../../shared/contracts.js';
import { secondsToMicros } from '../billing/money.js';
import { AppError } from '../errors.js';

export async function inspectAsset(path: string, kind: AssetKind, ffprobe: string) {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mov,mp3,wav,image2,png_pipe,jpeg_pipe,webp_pipe,gif',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,duration,r_frame_rate:format=format_name,duration',
        '-of',
        'json',
        path,
      ],
      { shell: false, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += String(chunk);
      if (text.length > 65536) child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error('Invalid media'))));
  }).catch(() => {
    throw new AppError(
      400,
      'invalid_media',
      'Не вдалося прочитати файл. Перевірте формат і цілісність.',
    );
  });
  const data = JSON.parse(output);
  const video = data.streams?.find((s: Record<string, unknown>) => s.codec_type === 'video');
  const audio = data.streams?.find((s: Record<string, unknown>) => s.codec_type === 'audio');
  const format = String(data.format?.format_name || '');
  let mime = '',
    extension = '',
    durationMicros = 0;
  if (kind === 'image') {
    const codecs: Record<string, [string, string]> = {
      png: ['image/png', 'png'],
      mjpeg: ['image/jpeg', 'jpg'],
      webp: ['image/webp', 'webp'],
      gif: ['image/gif', 'gif'],
    };
    if (!video || !codecs[video.codec_name] || /mov|mp3|wav/.test(format))
      throw new AppError(400, 'invalid_image', 'Потрібне зображення PNG, JPEG, WebP або GIF.');
    [mime, extension] = codecs[video.codec_name];
  } else {
    if (
      kind === 'video' &&
      (!video || !format.includes('mov') || !['h264', 'hevc'].includes(video.codec_name))
    )
      throw new AppError(400, 'invalid_video', 'Потрібне MP4/MOV відео з кодеком H.264 або H.265.');
    if (kind === 'audio' && (video || !audio || !/mp3|wav/.test(format)))
      throw new AppError(400, 'invalid_audio', 'Потрібне аудіо MP3 або WAV.');
    const stream = kind === 'video' ? video : audio;
    try {
      durationMicros = secondsToMicros(
        stream.duration && stream.duration !== 'N/A' ? stream.duration : data.format?.duration,
      );
    } catch {
      throw new AppError(400, 'invalid_duration', 'Не вдалося виміряти тривалість файлу.');
    }
    if (durationMicros < 2_000_000 || durationMicros > 30_000_000)
      throw new AppError(
        400,
        'media_duration',
        'Референс має тривати від 2 до 30 секунд. Для edit — від 4 секунд.',
      );
    [mime, extension] =
      kind === 'video'
        ? ['video/mp4', 'mp4']
        : format.includes('wav')
          ? ['audio/wav', 'wav']
          : ['audio/mpeg', 'mp3'];
  }
  if (video) {
    const { width: w, height: h } = video;
    if (
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w < 300 ||
      h < 300 ||
      w > 6000 ||
      h > 6000 ||
      w / h < 0.4 ||
      w / h > 2.5
    )
      throw new AppError(
        400,
        'media_dimensions',
        'Сторони зображення або відео: 300–6000 px; пропорції: 0,4–2,5.',
      );
    if (kind === 'video' && (w * h < 409600 || w * h > 8295044))
      throw new AppError(
        400,
        'video_pixels',
        'Відео має містити від 409600 до 8295044 пікселів у кадрі. Наприклад, 854×480.',
      );
  }
  return {
    mime,
    extension,
    durationMicros,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}
