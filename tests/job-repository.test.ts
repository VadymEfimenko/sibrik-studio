import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJob } from '../src/server/billing/credits.js';
import { loadConfig } from '../src/server/config.js';
import { createPool } from '../src/server/db/connection.js';
import { migrate } from '../src/server/db/migrations.js';
import type { JobRow } from '../src/server/db/rows.js';
import { JobRepository } from '../src/server/jobs/job-repository.js';

const pool = createPool(loadConfig().databaseUrl);
const repository = new JobRepository(pool);
const input = {
  modelId: 'seedance-2.5',
  prompt: 'A quiet forest',
  duration: 4,
  resolution: '480p',
} as const;
const readJob = async (id: string) =>
  (await pool.query<JobRow>('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query('TRUNCATE ledger,jobs,mock_provider_tasks RESTART IDENTITY');
  await pool.query('UPDATE users SET initial_milli=100000,available_milli=100000,held_milli=0');
});
afterAll(() => pool.end());

describe('Queue transitions and lease fencing', () => {
  it('gives one worker ownership and rejects writes and renewals from an expired owner', async () => {
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200);
    const claims = await Promise.all([repository.claim(), new JobRepository(pool).claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    expect(old.processing_attempt).toBe(0);
    expect(await repository.markSubmitting(old)).toBe(true);
    await pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
    await repository.renewLease(old);
    const expired = await readJob(id);
    expect(expired.lease_until!.getTime()).toBeLessThan(Date.now());
    const owner = (await repository.claim())!;
    expect(owner.lease_token).not.toBe(old.lease_token);
    expect(owner.processing_attempt).toBe(1);
    const before = await readJob(id);
    expect(await repository.markSubmitted(old, 'stale-task')).toBe(false);
    await repository.renewLease(old);
    expect(await readJob(id)).toEqual(before);
    expect(await repository.markSubmitted(owner, 'current-task')).toBe(true);
    expect(await readJob(id)).toMatchObject({
      provider_task_id: 'current-task',
      poll_attempt: 2,
      lease_token: null,
    });
  });
  it('keeps named update fields distinct, including zero progress and decimal costs', async () => {
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200);
    const owner = (await repository.claim())!;
    await pool.query(
      "UPDATE jobs SET provider_task_id='task',progress=50,error_code='old',error_message='old',provider_credits_cost=1.25 WHERE id=$1",
      [id],
    );
    expect(
      await repository.recordProgress(
        owner,
        {
          state: 'processing',
          progress: 0,
          costUsd: '0.0000000001',
          creditsCost: null,
        },
        5000,
      ),
    ).toBe(true);
    expect(await readJob(id)).toMatchObject({
      status: 'processing',
      progress: 0,
      provider_task_id: 'task',
      provider_cost_usd: '0.0000000001',
      provider_credits_cost: '1.2500000000',
      error_code: null,
      error_message: null,
      lease_token: null,
      lease_until: null,
      retry_not_before: null,
      poll_attempt: 1,
      download_attempt: 0,
    });
  });
  it('preserves a callback wake-up that arrives during the provider GET', async () => {
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200);
    const owner = (await repository.claim())!;
    await pool.query('UPDATE jobs SET last_webhook_at=now() WHERE id=$1', [id]);
    await repository.recordProgress(
      owner,
      { state: 'processing', progress: 50, costUsd: null, creditsCost: null },
      60000,
    );
    const saved = await readJob(id);
    expect(saved.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(saved.retry_not_before).toBeNull();
    expect(await repository.claim()).toMatchObject({ id });
  });
  it('honors Retry-After despite a callback, but lets the deadline release the hold', async () => {
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200);
    const owner = (await repository.claim())!;
    await pool.query('UPDATE jobs SET last_webhook_at=now() WHERE id=$1', [id]);
    await repository.retryPoll(owner, 60000);
    const saved = await readJob(id);
    expect(saved.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(saved.retry_not_before!.getTime()).toBeGreaterThan(Date.now() + 50000);
    expect(await repository.claim()).toBeUndefined();
    await pool.query("UPDATE jobs SET deadline_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect(await repository.claim()).toMatchObject({ id, processing_attempt: 1 });
  });
});
