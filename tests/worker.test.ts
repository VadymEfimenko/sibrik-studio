import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createJob } from '../src/server/billing/credits.js';
import { ProviderError } from '../src/server/errors.js';
import { Worker } from '../src/server/jobs/worker.js';
import { probeVideo } from '../src/server/media/storage.js';
import { ApiMartProvider } from '../src/server/providers/apimart.js';
import { MockProvider } from '../src/server/providers/mock.js';
import type { VideoProvider } from '../src/server/providers/types.js';

import { createTestContext } from './helpers/test-context.js';
const { config, pool, input, makeJob, wallet, job, due } = createTestContext();

describe('Worker, files and recovery', () => {
  const provider = () => new MockProvider(pool, config.fixtureDir, 0);
  it('downloads, probes and settles a complete mock generation', async () => {
    const worker = new Worker(pool, config, { mock: provider() });
    const { id } = await makeJob();
    await worker.runOnce();
    await due(id);
    await worker.runOnce();
    const current = await job(id);
    expect(current.status).toBe('completed');
    expect(current.actual_duration_us).toBe('3600000');
    expect((await stat(join(config.storageDir, current.result_file))).size).toBeGreaterThan(1000);
    expect(current.provider_cost_usd).toBeNull();
    expect(await wallet()).toMatchObject({ available_milli: 89740, held_milli: 0 });
  });
  it('has only one submission with two simultaneous workers', async () => {
    const submit = vi.fn(provider().submit.bind(provider()));
    const adapter: VideoProvider = { submit, poll: vi.fn(), result: vi.fn() };
    await makeJob();
    await Promise.all([
      new Worker(pool, config, { mock: adapter }).runOnce(),
      new Worker(pool, config, { mock: adapter }).runOnce(),
    ]);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('resumes known tasks after worker restart', async () => {
    const { id } = await makeJob();
    await new Worker(pool, config, { mock: provider() }).runOnce();
    await due(id);
    await new Worker(pool, config, { mock: provider() }).runOnce();
    expect((await job(id)).status).toBe('completed');
  });
  it('does not repeat an ambiguous paid submission', async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(new ProviderError('lost', 'Response lost', true, true));
    const worker = new Worker(pool, config, { mock: { submit, poll: vi.fn(), result: vi.fn() } });
    const { id } = await makeJob();
    await worker.runOnce();
    await due(id);
    await worker.runOnce();
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await job(id)).status).toBe('submission_unknown');
    await pool.query("UPDATE jobs SET deadline_at=now()-interval '1 second' WHERE id=$1", [id]);
    await worker.runOnce();
    expect((await job(id)).status).toBe('timed_out');
    expect((await wallet()).available_milli).toBe(100000);
  });
  it('recovers a crashed submitting state conservatively', async () => {
    const { id } = await makeJob();
    await pool.query(
      "UPDATE jobs SET status='submitting',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",
      [id, randomUUID()],
    );
    const submit = vi.fn();
    await new Worker(pool, config, { mock: { submit, poll: vi.fn(), result: vi.fn() } }).runOnce();
    expect(submit).not.toHaveBeenCalled();
    expect((await job(id)).status).toBe('submission_unknown');
  });
  it.each(['provider_400', 'provider_402'])('returns the full hold on %s', async (code) => {
    const { id } = await makeJob();
    const adapter: VideoProvider = {
      submit: vi.fn().mockRejectedValue(new ProviderError(code, 'Rejected')),
      poll: vi.fn(),
      result: vi.fn(),
    };
    await new Worker(pool, config, { mock: adapter }).runOnce();
    expect((await job(id)).status).toBe('failed');
    expect((await wallet()).available_milli).toBe(100000);
  });
  it('retries submit after definite rate limiting', async () => {
    const real = provider();
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('provider_429', 'Busy', true, false, 5000))
      .mockImplementation(real.submit.bind(real));
    const worker = new Worker(pool, config, {
      mock: { submit, poll: real.poll.bind(real), result: real.result.bind(real) },
    });
    const { id } = await makeJob();
    await worker.runOnce();
    expect((await job(id)).status).toBe('queued');
    expect(await worker.runOnce()).toBe(false);
    await due(id);
    await worker.runOnce();
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it('preserves the APIMart submission key across a 429 and worker restart', async () => {
    const fetcher = vi
      .fn(async (_url: string | URL | Request, request?: RequestInit) => {
        const key = new Headers(request?.headers).get('Idempotency-Key');
        return new Response(JSON.stringify({ code: 200, data: [{ task_id: `remote-${key}` }] }), {
          status: 200,
        });
      })
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '5' } }));
    const worker = () =>
      new Worker(pool, config, {
        apimart: new ApiMartProvider(
          {
            apiKey: 'test-key-not-real',
            baseUrl: 'https://api.apimart.ai',
            timeoutMs: 1000,
            webhookBase: '',
          },
          fetcher,
        ),
      });
    const { id } = await createJob(pool, input, randomUUID(), 'apimart', 1200);
    await worker().runOnce();
    expect((await job(id)).status).toBe('queued');
    await due(id);
    // Recreate both the worker and adapter. Neither may generate a fresh request key.
    await worker().runOnce();
    expect((await job(id)).provider_task_id).toBe(`remote-${id}`);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).duration).toBe(4);
    expect(await job(id)).toMatchObject({ hold_milli: 14250, estimate_milli: 11400 });
    expect(
      (await pool.query('SELECT count(*) FROM ledger WHERE job_id=$1', [id])).rows[0].count,
    ).toBe('1');

    // A different job with the same prompt must still be a distinct paid request.
    const next = await createJob(pool, input, randomUUID(), 'apimart', 1200);
    await worker().runOnce();
    expect((await job(next.id)).provider_task_id).toBe(`remote-${next.id}`);
    expect(
      fetcher.mock.calls.map(([, request]) => new Headers(request?.headers).get('Idempotency-Key')),
    ).toEqual([id, id, next.id]);
  });
  it('result endpoint 429 preserves the hold and media retry budget', async () => {
    const real = provider();
    const result = vi
      .fn()
      .mockRejectedValue(new ProviderError('provider_429', 'Wait', true, false, 120000));
    const worker = new Worker(pool, config, {
      mock: { submit: real.submit.bind(real), poll: real.poll.bind(real), result },
    });
    const { id } = await makeJob();
    await worker.runOnce();
    await due(id);
    await worker.runOnce();
    const current = await job(id);
    expect(current.download_attempt).toBe(0);
    expect(current.financial_status).toBe('held');
    expect(current.retry_not_before.getTime() - Date.now()).toBeGreaterThan(115000);
    expect(await worker.runOnce()).toBe(false);
  });
  it('keeps provider expenditure when an async task fails', async () => {
    const real = provider();
    const worker = new Worker(pool, config, {
      mock: {
        submit: real.submit.bind(real),
        result: vi.fn(),
        poll: vi
          .fn()
          .mockResolvedValue({ state: 'failed', progress: 0, costUsd: '0.1', creditsCost: '1' }),
      },
    });
    const { id } = await makeJob();
    await worker.runOnce();
    await due(id);
    await worker.runOnce();
    expect(await job(id)).toMatchObject({
      financial_status: 'released',
      provider_cost_usd: '0.1000000000',
    });
    expect((await wallet()).available_milli).toBe(100000);
  });
  it('rejects corrupt or non-video results and eventually refunds', async () => {
    const path = join(config.storageDir, 'corrupt.mp4');
    await writeFile(path, 'this is not a video');
    await expect(probeVideo(path, config.ffprobePath)).rejects.toThrow();
    const real = provider();
    const worker = new Worker(pool, config, {
      mock: {
        submit: real.submit.bind(real),
        poll: real.poll.bind(real),
        result: vi
          .fn()
          .mockResolvedValue({ source: { kind: 'file', path }, costUsd: null, creditsCost: null }),
      },
    });
    const { id } = await makeJob();
    await worker.runOnce();
    for (let i = 0; i < 3; i++) {
      await due(id);
      await worker.runOnce();
    }
    expect((await job(id)).status).toBe('failed');
    expect((await wallet()).available_milli).toBe(100000);
  });
});
