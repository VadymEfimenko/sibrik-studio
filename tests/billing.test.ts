import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createJob, estimate, release, settle } from '../src/server/billing/credits.js';
import { costForMicros, creditsToMilli, secondsToMicros } from '../src/server/billing/money.js';
import { migrate } from '../src/server/db/migrations.js';

import { createTestContext } from './helpers/test-context.js';
const { pool, input, makeJob, stored, wallet, job } = createTestContext();

describe('Credit accounting on real PostgreSQL', () => {
  it('rounds only once in integer milli-credits', () => {
    expect(creditsToMilli('2.85')).toBe(2850);
    expect(secondsToMicros('3.600000')).toBe(3600000);
    expect(secondsToMicros('0.0000001')).toBe(1);
    expect(costForMicros(3333333, 2850)).toBe(9500);
    expect(() => creditsToMilli('2.8501')).toThrow();
    expect(() => secondsToMicros('NaN')).toThrow();
    expect(() => secondsToMicros('0')).toThrow();
  });
  it('estimates without writing a job or financial operation', async () => {
    expect(await estimate(pool, input)).toMatchObject({
      estimatedMilli: 11400,
      holdMilli: 14250,
      expectedOutputSeconds: 4,
      reservedOutputSeconds: 5,
    });
    expect((await pool.query('SELECT count(*) FROM ledger')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM jobs')).rows[0].count).toBe('0');
  });
  it('atomically reserves and idempotently replays the same request', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => makeJob(key)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await wallet()).toMatchObject({ available_milli: 85750, held_milli: 14250 });
    expect((await pool.query('SELECT count(*) FROM ledger')).rows[0].count).toBe('1');
  });
  it('rejects reuse of a key with different input', async () => {
    const key = randomUUID();
    await makeJob(key);
    await expect(
      createJob(pool, { ...input, duration: 5 }, key, 'mock', 1200),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('never overspends under 20 simultaneous Generate requests', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => makeJob()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(13);
    expect(await wallet()).toMatchObject({ available_milli: 250, held_milli: 99750 });
    expect((await pool.query('SELECT count(*) FROM jobs')).rows[0].count).toBe('7');
  });
  it('replays successfully even when there are no credits left', async () => {
    await pool.query('UPDATE users SET initial_milli=14250,available_milli=14250');
    const key = randomUUID();
    const first = await makeJob(key);
    expect(await makeJob(key)).toEqual({ id: first.id, created: false });
  });
  it('requires enough available credits for the buffer before creating a job', async () => {
    await pool.query('UPDATE users SET initial_milli=11400,available_milli=11400');
    await expect(makeJob()).rejects.toMatchObject({
      code: 'insufficient_credits',
      statusCode: 402,
    });
    expect(await wallet()).toMatchObject({ available_milli: 11400, held_milli: 0 });
    expect((await pool.query('SELECT count(*) FROM jobs')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM ledger')).rows[0].count).toBe('0');
  });
  it('charges the full fractional result duration and releases the unused buffer once', async () => {
    const { id } = await makeJob();
    await Promise.all(Array.from({ length: 10 }, () => settle(pool, id, stored(4.041667))));
    expect(await release(pool, id, 'late', 'Late failure')).toBe(false);
    expect(await job(id)).toMatchObject({
      hold_milli: 14250,
      estimate_milli: 11400,
      actual_duration_us: '4041667',
      actual_cost_milli: 11519,
      charged_milli: 11519,
      released_milli: 2731,
      absorbed_milli: 0,
    });
    expect(await wallet()).toMatchObject({ available_milli: 88481, held_milli: 0 });
    expect((await pool.query('SELECT kind,amount_milli FROM ledger ORDER BY id')).rows).toEqual([
      { kind: 'hold', amount_milli: 14250 },
      { kind: 'settle', amount_milli: 11519 },
      { kind: 'release', amount_milli: 2731 },
    ]);
  });
  it('uses the whole buffer when the result is exactly one second longer', async () => {
    const { id } = await makeJob();
    await settle(pool, id, stored(5));
    expect(await job(id)).toMatchObject({
      actual_cost_milli: 14250,
      charged_milli: 14250,
      released_milli: 0,
      absorbed_milli: 0,
    });
    expect(await wallet()).toMatchObject({ available_milli: 85750, held_milli: 0 });
    expect((await pool.query('SELECT kind,amount_milli FROM ledger ORDER BY id')).rows).toEqual([
      { kind: 'hold', amount_milli: 14250 },
      { kind: 'settle', amount_milli: 14250 },
    ]);
  });
  it('preserves a legacy hold on replay and settlement', async () => {
    const key = randomUUID();
    const { id } = await makeJob(key);
    // Reconstruct a pending job created before the extra second was introduced.
    await pool.query('UPDATE jobs SET hold_milli=11400 WHERE id=$1', [id]);
    await pool.query('UPDATE users SET available_milli=88600,held_milli=11400');
    await pool.query(
      `UPDATE ledger SET amount_milli=11400,available_delta_milli=-11400,
       held_delta_milli=11400,available_after_milli=88600,held_after_milli=11400
       WHERE job_id=$1 AND kind='hold'`,
      [id],
    );
    await migrate(pool);
    expect(await makeJob(key)).toEqual({ id, created: false });
    expect(await wallet()).toMatchObject({ available_milli: 88600, held_milli: 11400 });
    await settle(pool, id, stored(4.041667));
    expect(await job(id)).toMatchObject({
      hold_milli: 11400,
      actual_cost_milli: 11519,
      charged_milli: 11400,
      released_milli: 0,
      absorbed_milli: 119,
    });
    expect((await pool.query('SELECT kind,amount_milli FROM ledger ORDER BY id')).rows).toEqual([
      { kind: 'hold', amount_milli: 11400 },
      { kind: 'settle', amount_milli: 11400 },
    ]);
  });
  it('settles actual duration and returns the difference exactly once', async () => {
    const { id } = await makeJob();
    await Promise.all(Array.from({ length: 10 }, () => settle(pool, id, stored())));
    expect(await wallet()).toMatchObject({ available_milli: 89740, held_milli: 0 });
    expect(await job(id)).toMatchObject({
      charged_milli: 10260,
      released_milli: 3990,
      actual_duration_us: '3600000',
      provider_cost_usd: '0.3800000000',
    });
    expect((await pool.query('SELECT kind,amount_milli FROM ledger ORDER BY id')).rows).toEqual([
      { kind: 'hold', amount_milli: 14250 },
      { kind: 'settle', amount_milli: 10260 },
      { kind: 'release', amount_milli: 3990 },
    ]);
  });
  it('covers output beyond the duration buffer without creating a negative balance', async () => {
    await pool.query('UPDATE users SET initial_milli=14250,available_milli=14250');
    const { id } = await makeJob();
    await settle(pool, id, stored(6));
    expect(await wallet()).toMatchObject({ available_milli: 0, held_milli: 0 });
    expect(await job(id)).toMatchObject({
      actual_cost_milli: 17100,
      charged_milli: 14250,
      absorbed_milli: 2850,
    });
  });
  it('uses the saved rate even if the model rate changes', async () => {
    const { id } = await makeJob();
    await pool.query('UPDATE models SET rate_milli=9000');
    await settle(pool, id, stored());
    expect((await job(id)).charged_milli).toBe(10260);
  });
  it('release racing with settlement has one financial outcome', async () => {
    const { id } = await makeJob();
    const results = await Promise.all([
      release(pool, id, 'failed', 'Failed'),
      settle(pool, id, stored()),
      release(pool, id, 'failed', 'Failed'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const current = await job(id);
    const balance = await wallet();
    expect(balance.held_milli).toBe(0);
    expect(balance.available_milli + current.charged_milli).toBe(100000);
  });
  it('late completion cannot charge after timeout or release', async () => {
    const { id } = await makeJob();
    await pool.query("UPDATE jobs SET deadline_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect(await settle(pool, id, stored())).toBe(false);
    expect((await job(id)).status).toBe('timed_out');
    expect(await settle(pool, id, stored())).toBe(false);
    expect(await wallet()).toMatchObject({ available_milli: 100000, held_milli: 0 });
  });
  it('rejects stale worker leases', async () => {
    const { id } = await makeJob();
    const lease = randomUUID();
    await pool.query(
      "UPDATE jobs SET lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
      [id, lease],
    );
    expect(await settle(pool, id, stored(), randomUUID())).toBe(false);
    expect(await release(pool, id, 'failed', 'Failed', 'failed', randomUUID())).toBe(false);
    expect(await settle(pool, id, stored(), lease)).toBe(true);
  });
  it('rolls back job, wallet and ledger together on database failure', async () => {
    // Duplicate ledger index simulates a failure after the wallet update.
    const { id } = await makeJob();
    await pool.query('CREATE UNIQUE INDEX fail_test ON ledger((true))');
    try {
      await expect(settle(pool, id, stored())).rejects.toThrow();
    } finally {
      await pool.query('DROP INDEX fail_test');
    }
    expect((await job(id)).financial_status).toBe('held');
    expect(await wallet()).toMatchObject({ available_milli: 85750, held_milli: 14250 });
  });
  it('startup never refills the existing wallet', async () => {
    const { id } = await makeJob();
    await settle(pool, id, stored());
    await migrate(pool, 500000, 9999);
    expect((await wallet()).available_milli).toBe(89740);
    expect((await pool.query('SELECT rate_milli FROM models')).rows[0].rate_milli).toBe(2850);
  });
});
