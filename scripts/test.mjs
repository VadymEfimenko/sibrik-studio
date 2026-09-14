import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { command, localDatabase, mediaEnvironment } from './runtime.mjs';
const temp = await mkdtemp(join(tmpdir(), 'sibrik-tests-'));
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
let database;
let failed = false;
try {
  const env = mediaEnvironment();
  await command(process.execPath, ['scripts/create-fixtures.mjs'], env);
  database = await localDatabase(join(temp, 'postgres'), port, false);
  env.DATABASE_URL = database.url;
  env.STORAGE_DIR = join(temp, 'videos');
  env.PROVIDER_MODE = 'mock';
  env.APIMART_API_KEY = '';
  env.WEBHOOK_BASE_URL = '';
  env.LOG_LEVEL = 'silent';
  await command(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', '--no-file-parallelism'],
    env,
  );
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  await database?.stop();
  await rm(temp, { recursive: true, force: true });
  // Embedded database cleanup must not obscure a failed test process.
  if (failed) process.exitCode = 1;
}
