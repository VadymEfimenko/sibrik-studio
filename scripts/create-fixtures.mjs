import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// These small, synthetic clips are test fixtures, never presented as AI output.
const binary = process.env.FFMPEG_PATH || (await import('ffmpeg-static')).default;
await mkdir('public/demo', { recursive: true });
for (const [requested, actual] of [
  [4, 3.6],
  [5, 4.5],
]) {
  const path = resolve(`public/demo/demo-${requested}.mp4`);
  if (existsSync(path)) continue;
  const result = spawnSync(
    binary,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=854x480:rate=30',
      '-t',
      String(actual),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      path,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0)
    throw new Error(`Cannot create demo fixture: ${result.error || result.status}`);
}
console.log('Demo videos ready (3.6 s and 4.5 s).');
