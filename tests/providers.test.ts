import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJob, release } from '../src/server/billing/credits.js';
import { Assets } from '../src/server/assets/service.js';
import { loadConfig } from '../src/server/config.js';
import { migrate } from '../src/server/db/migrations.js';
import { buildApp } from '../src/server/http/app.js';
import { buildCallbackApp } from '../src/server/http/callback-app.js';
import { Worker } from '../src/server/jobs/worker.js';
import { createProviders } from '../src/server/providers/create-providers.js';
import type { AssetProvider, VideoProvider } from '../src/server/providers/types.js';
import type { ProviderInput } from '../src/shared/contracts.js';
import { createTestContext } from './helpers/test-context.js';

const { config, pool, input, job, due, wallet } = createTestContext();
const otherConfig = {
  ...config,
  mode: 'independent',
  mediaBase: '',
  webhookBase: 'https://example.test',
};
beforeEach(async () => {
  await pool.query('TRUNCATE assets');
});

/** A different provider protocol and asset scheme, without extending APIMart or Mock. */
function independentProvider(withAssets = true): VideoProvider {
  const assets: AssetProvider = {
    scope: 'independent:account-one',
    requiresPublicMedia: false,
    prepare: vi.fn(async (file) => ({ status: 'processing' as const, taskId: `scan-${file.id}` })),
    poll: vi.fn(async (taskId) => ({ status: 'ready' as const, url: `independent://${taskId}` })),
  };
  return {
    displayName: 'Independent Test',
    ...(withAssets ? { assets } : {}),
    pollIntervalMs: 43210,
    webhook: {
      path: '/independent/events',
      taskId(body) {
        return typeof body === 'object' &&
          body !== null &&
          'operation' in body &&
          typeof body.operation === 'string'
          ? body.operation
          : null;
      },
    },
    submit: vi.fn(async (_input: ProviderInput, _key: string) => ({ taskId: 'remote-shared' })),
    poll: vi
      .fn()
      .mockResolvedValueOnce({
        state: 'processing',
        progress: 23,
        costUsd: null,
        creditsCost: null,
      })
      .mockResolvedValue({
        state: 'completed',
        progress: 100,
        costUsd: '0.25',
        creditsCost: '2.5',
      }),
    result: vi.fn(async () => ({
      source: { kind: 'file' as const, path: join(config.fixtureDir, 'demo-4.mp4') },
      costUsd: '0.25',
      creditsCost: '2.5',
    })),
  };
}

describe('Provider extension boundary', () => {
  it('accepts immediately prepared references without requiring a moderation task or asset:// URL', async () => {
    const provider: AssetProvider = {
      scope: 'direct:account-one',
      requiresPublicMedia: false,
      prepare: async () => ({ status: 'ready', url: 'https://cdn.example.test/reference.mp4' }),
      poll: vi.fn(),
    };
    const manager = new Assets(pool, otherConfig, provider);
    const asset = await manager.ingest(
      createReadStream(join(config.fixtureDir, 'demo-5.mp4')),
      'video',
      'direct.mp4',
    );
    await manager.prepare(asset.id);
    expect(await manager.get(asset.id)).toMatchObject({ status: 'ready', error: null });
    const row = (
      await pool.query(
        'SELECT provider_url,provider_task_id,public_until FROM assets WHERE id=$1',
        [asset.id],
      )
    ).rows[0];
    expect(row).toEqual({
      provider_url: 'https://cdn.example.test/reference.mp4',
      provider_task_id: null,
      public_until: null,
    });
    expect(provider.poll).not.toHaveBeenCalled();
    await manager.stop();
  });
  it('registers an unknown provider ID and completes references, callback, download and billing through the existing API', async () => {
    const adapter = independentProvider();
    const providers = createProviders(pool, otherConfig, {}, { independent: () => adapter });
    const app = await buildApp(pool, otherConfig, providers);
    const callback = await buildCallbackApp(pool, otherConfig, providers);
    const worker = new Worker(pool, otherConfig, providers);
    try {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/api/assets/upload?kind=video&name=reference.mp4',
        headers: { 'content-type': 'application/octet-stream' },
        payload: await readFile(join(config.fixtureDir, 'demo-5.mp4')),
      });
      expect(uploaded.statusCode).toBe(201);
      const assetId = uploaded.json().id;
      await app.inject({ method: 'POST', url: `/api/assets/${assetId}/retry` });
      expect(adapter.assets!.prepare).toHaveBeenCalledTimes(1);
      await pool.query('UPDATE assets SET next_attempt_at=now() WHERE id=$1', [assetId]);
      expect(
        (await app.inject({ method: 'POST', url: `/api/assets/${assetId}/retry` })).json().status,
      ).toBe('ready');
      const request = {
        ...input,
        taskType: 'reference',
        references: [{ assetId, role: 'reference' }],
      };
      const quote = (
        await app.inject({ method: 'POST', url: '/api/estimate', payload: request })
      ).json();
      expect(quote).toMatchObject({ inputSeconds: 4.5, estimatedMilli: 24225, holdMilli: 27075 });
      const headers = { 'idempotency-key': randomUUID() };
      const created = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers,
        payload: request,
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;
      await worker.runOnce();
      expect(adapter.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          media: [
            expect.objectContaining({
              url: `independent://scan-${assetId}`,
              durationMicros: 4500000,
            }),
          ],
        }),
        id,
      );
      await due(id);
      await worker.runOnce();
      const pending = await job(id);
      expect(pending.progress).toBe(23);
      expect(pending.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(40000);
      const event = {
        method: 'POST' as const,
        url: '/independent/events',
        payload: { operation: 'remote-shared', cost: 9999 },
      };
      expect((await callback.inject(event)).statusCode).toBe(200);
      expect((await job(id)).financial_status).toBe('held');
      await worker.runOnce();
      expect(await job(id)).toMatchObject({
        mode: 'independent',
        status: 'completed',
        charged_milli: 23085,
        released_milli: 3990,
      });
      expect(await wallet()).toMatchObject({ available_milli: 76915, held_milli: 0 });
      const media = await app.inject({ url: `/media/${id}`, headers: { range: 'bytes=0-63' } });
      expect(media.statusCode).toBe(206);
      expect(media.rawPayload.length).toBe(64);
      await callback.inject(event);
      await callback.inject(event);
      expect(await worker.runOnce()).toBe(false);
      expect(
        (await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: request })).json()
          .id,
      ).toBe(id);
      expect(
        (await pool.query('SELECT count(*) FROM ledger WHERE job_id=$1', [id])).rows[0].count,
      ).toBe('3');
      const state = (await app.inject('/api/state')).json();
      expect(state).toMatchObject({
        providerName: 'Independent Test',
        mode: 'independent',
        transport: 'webhook',
      });
      expect((await callback.inject('/api/state')).statusCode).toBe(404);
    } finally {
      await app.close();
      await callback.close();
    }
  });

  it('supports a polling-only adapter without assets even when a global webhook URL exists', async () => {
    const original = independentProvider(false);
    const adapter: VideoProvider = {
      submit: original.submit,
      poll: original.poll,
      result: original.result,
    };
    const providers = { independent: adapter };
    const app = await buildApp(pool, otherConfig, providers);
    const callback = await buildCallbackApp(pool, otherConfig, providers);
    try {
      expect((await app.inject('/api/state')).json().transport).toBe('polling');
      expect(
        (await callback.inject({ method: 'POST', url: '/callback', payload: {} })).statusCode,
      ).toBe(404);
      const upload = await app.inject({
        method: 'POST',
        url: '/api/assets/upload?kind=video',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('unused'),
      });
      expect(upload.statusCode).toBe(422);
      expect(upload.json().error.code).toBe('references_unsupported');
      expect((await pool.query('SELECT count(*) FROM assets')).rows[0].count).toBe('0');
      const { id } = await createJob(pool, input, randomUUID(), 'independent', 1200);
      const worker = new Worker(pool, otherConfig, providers);
      await worker.runOnce();
      await due(id);
      await worker.runOnce();
      expect((await job(id)).next_attempt_at.getTime() - Date.now()).toBeLessThan(30000);
      await due(id);
      await worker.runOnce();
      expect((await job(id)).charged_milli).toBe(10260);
    } finally {
      await app.close();
      await callback.close();
    }
  });

  it('isolates matching remote task IDs by provider and ignores unknown or late callbacks', async () => {
    const adapter = independentProvider();
    const callback = await buildCallbackApp(pool, otherConfig, { independent: adapter });
    try {
      const first = await createJob(pool, input, randomUUID(), 'independent', 1200);
      const second = await createJob(pool, input, randomUUID(), 'apimart', 1200);
      await pool.query(
        "UPDATE jobs SET provider_task_id='remote-shared',status='processing',next_attempt_at=now()+interval '1 hour'",
      );
      const send = (operation: string) =>
        callback.inject({ method: 'POST', url: '/independent/events', payload: { operation } });
      await send('unknown');
      expect((await job(first.id)).last_webhook_at).toBeNull();
      await send('remote-shared');
      expect((await job(first.id)).last_webhook_at).not.toBeNull();
      expect((await job(second.id)).last_webhook_at).toBeNull();
      expect((await wallet()).held_milli).toBe(28500);
      await release(pool, first.id, 'failed', 'Test failure');
      const before = await job(first.id);
      await send('remote-shared');
      expect(await job(first.id)).toEqual(before);
    } finally {
      await callback.close();
    }
  });

  it('upgrades the old two-provider constraint without changing existing jobs or balances', async () => {
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200);
    const beforeJob = await job(id),
      beforeWallet = await wallet();
    await pool.query(
      "DELETE FROM schema_migrations WHERE version=3; ALTER TABLE jobs DROP CONSTRAINT jobs_mode_check; ALTER TABLE jobs ADD CONSTRAINT jobs_mode_check CHECK (mode IN ('mock','apimart'))",
    );
    try {
      await migrate(pool);
      await migrate(pool);
      expect(await job(id)).toEqual(beforeJob);
      expect(await wallet()).toEqual(beforeWallet);
      const added = await createJob(pool, input, randomUUID(), 'independent', 1200);
      expect((await job(added.id)).mode).toBe('independent');
    } finally {
      await migrate(pool);
    }
  });

  it('accepts a registered name through configuration and fails fast for unknown or unconfigured adapters', () => {
    const env = { DATABASE_URL: config.databaseUrl, PROVIDER_MODE: 'independent', PORT: '3333' };
    const loaded = loadConfig(env);
    expect(loaded).toMatchObject({ mode: 'independent', port: 3333 });
    expect(() => createProviders(pool, loaded, {}, {})).toThrow('not registered');
    expect(() => createProviders(pool, loaded, {}, { independent: () => undefined })).toThrow(
      'not registered or configured',
    );
    expect(() => loadConfig({ ...env, PROVIDER_MODE: '../bad' })).toThrow('PROVIDER_MODE');
    expect(() => createProviders(pool, { ...config, mode: 'apimart' }, {})).toThrow(
      'APIMART_API_KEY',
    );
    expect(() =>
      createProviders(
        pool,
        { ...config, mode: 'apimart' },
        { APIMART_API_KEY: 'test', APIMART_BASE_URL: 'http://example.test' },
      ),
    ).toThrow('HTTPS');
  });
});
