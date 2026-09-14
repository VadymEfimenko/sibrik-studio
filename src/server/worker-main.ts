import { loadConfig } from './config.js';
import { createPool } from './db/connection.js';
import { migrate } from './db/migrations.js';
import { Worker } from './jobs/worker.js';
import { createProviders } from './providers/create-providers.js';
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const providers = createProviders(pool, config);
await migrate(pool, config.initialMilli, config.rateMilli);
const worker = new Worker(pool, config, providers);
worker.start();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void worker
      .stop()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
