import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { command, localDatabase, mediaEnvironment } from './runtime.mjs';
if (existsSync('.env')) process.loadEnvFile('.env');
const env = mediaEnvironment();
await command(process.execPath, ['scripts/create-fixtures.mjs'], env);
const database = env.DATABASE_URL
  ? null
  : await localDatabase('.local/postgres', Number(env.LOCAL_PG_PORT || 54329), true);
if (database) env.DATABASE_URL = database.url;
const children = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('close', resolve);
          child.kill('SIGTERM');
        }),
    ),
  );
  await database?.stop();
  process.exit(code);
}
for (const args of [
  ['node_modules/tsx/dist/cli.mjs', 'watch', 'src/server/main.ts'],
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'],
]) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => {
    console.error(error.message);
    void stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) void stop(code || 0);
  });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void stop();
  });
