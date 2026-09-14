import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createJob } from '../src/server/billing/credits.js';
import { createProviders } from '../src/server/providers/create-providers.js';
import { buildApp } from '../src/server/http/app.js';
import { buildCallbackApp } from '../src/server/http/callback-app.js';
import { Worker } from '../src/server/jobs/worker.js';
import { MockProvider } from '../src/server/providers/mock.js';

import { createTestContext } from './helpers/test-context.js';
const { config, pool, input, makeJob, wallet, job, due } = createTestContext();

describe('HTTP contracts and callback isolation', () => {
  it('validates supported parameters and blocks cross-site writes', async () => {
    const app = await buildApp(pool, config, createProviders(pool, config));
    try {
      const headers = { 'idempotency-key': randomUUID() };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers,
            payload: { ...input, resolution: '4k' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers,
            payload: { ...input, fast: true },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { ...headers, origin: 'https://foreign.example' },
            payload: input,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/api/jobs', payload: input })).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: input }))
          .statusCode,
      ).toBe(201);
      expect(
        (await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: input }))
          .statusCode,
      ).toBe(200);
      expect((await app.inject('/api/state')).json().wallet.heldMilli).toBe(14250);
      expect((await app.inject('/callback')).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('serves only committed media and supports byte ranges', async () => {
    const { id } = await makeJob();
    const worker = new Worker(pool, config, { mock: new MockProvider(pool, config.fixtureDir, 0) });
    const app = await buildApp(pool, config, createProviders(pool, config));
    try {
      expect((await app.inject(`/media/${id}`)).statusCode).toBe(404);
      await worker.runOnce();
      await due(id);
      await worker.runOnce();
      const response = await app.inject({ url: `/media/${id}`, headers: { range: 'bytes=0-99' } });
      expect(response.statusCode).toBe(206);
      expect(response.rawPayload.length).toBe(100);
      expect(response.headers['content-type']).toContain('video/mp4');
    } finally {
      await app.close();
    }
  });
  it('webhooks only wake known tasks; they never settle or override Retry-After', async () => {
    const callback = await buildCallbackApp(
      pool,
      config,
      createProviders(pool, config, { APIMART_API_KEY: 'test-callback-key' }),
    );
    const { id } = await createJob(pool, input, randomUUID(), 'apimart', 1200);
    await pool.query(
      "UPDATE jobs SET provider_task_id='remote-123',status='processing',next_attempt_at=now()+interval '1 hour',retry_not_before=now()+interval '2 minutes' WHERE id=$1",
      [id],
    );
    try {
      for (const payload of [
        { id: 'unknown', status: 'completed' },
        {
          id: 'remote-123',
          status: 'completed',
          cost: 9999,
          result: { videos: [{ url: ['https://evil.example/video'] }] },
        },
      ]) {
        expect(
          (await callback.inject({ method: 'POST', url: '/callback', payload })).statusCode,
        ).toBe(200);
      }
      const current = await job(id);
      expect(current.last_webhook_at).not.toBeNull();
      expect(current.status).toBe('processing');
      expect(current.financial_status).toBe('held');
      expect(current.provider_cost_usd).toBeNull();
      expect((await wallet()).held_milli).toBe(14250);
      const poll = vi.fn();
      const worker = new Worker(pool, config, {
        apimart: { submit: vi.fn(), poll, result: vi.fn() },
      });
      expect(await worker.runOnce()).toBe(false);
      expect(poll).not.toHaveBeenCalled();
      expect((await callback.inject('/api/state')).statusCode).toBe(404);
    } finally {
      await callback.close();
    }
  });
  it('streams committed updates and resyncs on connect', async () => {
    const app = await buildApp(pool, config, createProviders(pool, config));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error();
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('resync');
      await makeJob();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('changed');
      await reader.cancel();
    } finally {
      controller.abort();
      await app.close();
    }
  });
});
