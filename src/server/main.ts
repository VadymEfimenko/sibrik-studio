import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { createPool } from './db/connection.js';
import { migrate } from './db/migrations.js';
import { buildApp } from './http/app.js';
import { buildCallbackApp } from './http/callback-app.js';
import { Worker } from './jobs/worker.js';
import { createProviders } from './providers/create-providers.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const providers = createProviders(pool, config);
await migrate(pool, config.initialMilli, config.rateMilli);
await mkdir(config.storageDir, { recursive: true });
const app = await buildApp(pool, config, providers);
const callback = await buildCallbackApp(pool, config, providers);
const worker = config.embeddedWorker ? new Worker(pool, config, providers) : null;
const host = process.env.HOST || '127.0.0.1';
await app.listen({ host, port: config.port });
await callback.listen({ host, port: config.callbackPort });
worker?.start();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker?.stop();
  await Promise.all([app.close(), callback.close()]);
  await pool.end();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
