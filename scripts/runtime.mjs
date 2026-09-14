import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';

export function mediaEnvironment() {
  return {
    ...process.env,
    FFMPEG_PATH:
      process.env.FFMPEG_PATH && process.env.FFMPEG_PATH !== 'ffmpeg'
        ? process.env.FFMPEG_PATH
        : ffmpeg,
    FFPROBE_PATH:
      process.env.FFPROBE_PATH && process.env.FFPROBE_PATH !== 'ffprobe'
        ? process.env.FFPROBE_PATH
        : ffprobe.path,
  };
}
export function command(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${binary} exited with ${code}`)),
    );
  });
}
export async function localDatabase(directory, port, persistent) {
  const path = resolve(directory);
  await mkdir(path, { recursive: true });
  const database = new EmbeddedPostgres({
    databaseDir: path,
    user: 'postgres',
    password: 'local_test_only',
    port,
    persistent,
    createPostgresUser: false,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: (message) => process.stderr.write(String(message)),
  });
  if (!existsSync(resolve(path, 'PG_VERSION'))) await database.initialise();
  await database.start();
  return {
    url: `postgresql://postgres:local_test_only@127.0.0.1:${port}/postgres`,
    stop: () => database.stop(),
  };
}
