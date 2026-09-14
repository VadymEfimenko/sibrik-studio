import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createJob } from '../../src/server/billing/credits.js';
import { loadConfig } from '../../src/server/config.js';
import { createPool } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations.js';
import type { JobRow, WalletRow } from '../../src/server/db/rows.js';
import type { GenerateInput } from '../../src/shared/contracts.js';

/** Registers an isolated suite lifecycle; the test runner owns the temporary database. */
export function createTestContext() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const input: GenerateInput = {
    modelId: 'seedance-2.5',
    prompt: 'A calm morning in the city',
    duration: 4,
    resolution: '480p',
  };
  const makeJob = (key = randomUUID()) => createJob(pool, input, key, 'mock', 1200);
  const stored = (seconds = 3.6) => ({
    durationMicros: Math.round(seconds * 1e6),
    resultFile: 'test.mp4',
    providerCostUsd: '0.38',
    providerCreditsCost: '3.8',
  });
  const wallet = async () =>
    (await pool.query<WalletRow>('SELECT * FROM users WHERE id=1')).rows[0];
  const job = async (id: string) =>
    (await pool.query<JobRow>('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
  const due = async (id: string) => {
    await pool.query(
      "UPDATE jobs SET next_attempt_at=now()-interval '1 second',retry_not_before=NULL WHERE id=$1",
      [id],
    );
  };
  beforeAll(async () => {
    await migrate(pool);
    await mkdir(config.storageDir, { recursive: true });
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE ledger,jobs,mock_provider_tasks RESTART IDENTITY');
    await pool.query('UPDATE users SET initial_milli=100000,available_milli=100000,held_milli=0');
    await pool.query('UPDATE models SET rate_milli=2850');
  });
  afterAll(() => pool.end());

  return { config, pool, input, makeJob, stored, wallet, job, due };
}
