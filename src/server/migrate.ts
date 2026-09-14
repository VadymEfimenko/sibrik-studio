import { loadConfig } from './config.js';
import { createPool } from './db/connection.js';
import { migrate } from './db/migrations.js';
const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  await migrate(pool, config.initialMilli, config.rateMilli);
  console.log('Database ready.');
} finally {
  await pool.end();
}
