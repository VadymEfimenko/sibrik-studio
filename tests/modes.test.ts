import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Assets } from '../src/server/assets/service.js';
import { createJob, estimate, release, settle } from '../src/server/billing/credits.js';
import { loadConfig } from '../src/server/config.js';
import { createPool } from '../src/server/db/connection.js';
import { migrate } from '../src/server/db/migrations.js';
import { createProviders } from '../src/server/providers/create-providers.js';
import { buildApp } from '../src/server/http/app.js';
import { buildCallbackApp } from '../src/server/http/callback-app.js';
import { inputSchema } from '../src/server/jobs/input.js';
import { Worker } from '../src/server/jobs/worker.js';
import { ApiMartAssets } from '../src/server/providers/apimart-assets.js';
import { ApiMartProvider } from '../src/server/providers/apimart.js';
import { MockProvider } from '../src/server/providers/mock.js';
import type { GenerateInput, ProviderInput } from '../src/shared/contracts.js';

const config = loadConfig(),
  pool = createPool(config.databaseUrl);
const basic: GenerateInput = {
  modelId: 'seedance-2.5',
  prompt: 'A quiet forest',
  resolution: '480p',
  duration: 4,
};
const assets = new Assets(pool, config, new MockProvider(pool, config.fixtureDir).assets);
const fixture = join(config.fixtureDir, 'demo-5.mp4');
const editing = async (): Promise<GenerateInput> => {
  const a = await assets.ingest(createReadStream(fixture), 'video', 'source.mp4');
  return {
    ...basic,
    taskType: 'edit',
    duration: -1,
    size: 'adaptive',
    references: [{ assetId: a.id, role: 'reference' }],
  };
};
beforeAll(async () => {
  await migrate(pool);
  await mkdir(config.storageDir, { recursive: true });
});
beforeEach(async () => {
  await pool.query('TRUNCATE ledger,jobs,mock_provider_tasks,assets RESTART IDENTITY');
  await pool.query('UPDATE users SET initial_milli=100000,available_milli=100000,held_milli=0');
  await pool.query('UPDATE models SET rate_milli=2850,rate_720_milli=5700,rate_1080_milli=11400');
});
afterAll(async () => {
  await assets.stop();
  await pool.end();
});

describe('Extended modes and verified reference accounting', () => {
  it('prices each resolution from the model catalogue', async () => {
    expect(await estimate(pool, { ...basic, resolution: '720p', duration: 10 })).toMatchObject({
      rateMilli: 5700,
      estimatedMilli: 57000,
      holdMilli: 62700,
    });
    expect(await estimate(pool, { ...basic, resolution: '1080p', duration: 8 })).toMatchObject({
      rateMilli: 11400,
      estimatedMilli: 91200,
      holdMilli: 102600,
    });
    expect(await estimate(pool, { ...basic, duration: 30 })).toMatchObject({
      estimatedMilli: 85500,
      holdMilli: 88350,
      expectedOutputSeconds: 30,
      reservedOutputSeconds: 31,
    });
    expect(await estimate(pool, { ...basic, duration: -1 })).toMatchObject({
      holdMilli: 85500,
      reservedOutputSeconds: 30,
      automaticDuration: true,
    });
  });
  it('holds for the maximum edit output and settles measured input + actual output only once', async () => {
    const input = await editing();
    expect(await estimate(pool, input, 'mock')).toMatchObject({
      inputSeconds: 4.5,
      expectedOutputSeconds: 4.5,
      estimatedMilli: 25650,
      holdMilli: 98325,
      reservedOutputSeconds: 30,
    });
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200, 'mock');
    await pool.query('UPDATE models SET rate_milli=9999');
    const result = {
      durationMicros: 4_200_000,
      resultFile: 'edited.mp4',
      providerCostUsd: null,
      providerCreditsCost: null,
    };
    await Promise.all(Array.from({ length: 12 }, () => settle(pool, id, result)));
    expect((await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]).toMatchObject({
      charged_milli: 24795,
      released_milli: 73530,
      input_duration_us: '4500000',
      rate_milli: 2850,
    });
    expect((await pool.query('SELECT kind,amount_milli FROM ledger ORDER BY id')).rows).toEqual([
      { kind: 'hold', amount_milli: 98325 },
      { kind: 'settle', amount_milli: 24795 },
      { kind: 'release', amount_milli: 73530 },
    ]);
    expect(await release(pool, id, 'late', 'late failure')).toBe(false);
  });
  it('adds the buffer only to output when using a measured video reference', async () => {
    const input: GenerateInput = {
      ...(await editing()),
      taskType: 'reference',
      duration: 4,
      size: '16:9',
    };
    expect(await estimate(pool, input, 'mock')).toMatchObject({
      inputSeconds: 4.5,
      expectedOutputSeconds: 4,
      reservedOutputSeconds: 5,
      estimatedMilli: 24225,
      holdMilli: 27075,
    });
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200, 'mock');
    await settle(pool, id, {
      durationMicros: 4_041_667,
      resultFile: 'reference.mp4',
      providerCostUsd: null,
      providerCreditsCost: null,
    });
    expect((await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0]).toMatchObject({
      input_duration_us: '4500000',
      actual_cost_milli: 24344,
      charged_milli: 24344,
      released_milli: 2731,
      absorbed_milli: 0,
    });
  });
  it('includes seed, audio, aspect, output format and references in idempotency', async () => {
    const key = randomUUID(),
      input = await editing();
    const first = await createJob(pool, input, key, 'mock', 1200);
    await pool.query("UPDATE assets SET status='failed'");
    expect(await createJob(pool, input, key, 'mock', 1200)).toEqual({ ...first, created: false });
    for (const change of [{ seed: 4 }, { generateAudio: false }, { outputFormat: 'mov' as const }])
      await expect(
        createJob(pool, { ...input, ...change }, key, 'mock', 1200),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('blocks unready assets, wrong accounts and impossible combinations before holding', async () => {
    const input = await editing();
    await expect(estimate(pool, input, 'different-key')).rejects.toMatchObject({
      code: 'missing_asset',
    });
    await pool.query("UPDATE assets SET status='processing'");
    await expect(createJob(pool, input, randomUUID(), 'mock', 1200)).rejects.toMatchObject({
      code: 'asset_not_ready',
    });
    expect((await pool.query('SELECT count(*) FROM ledger')).rows[0].count).toBe('0');
    expect(() => inputSchema.parse({ ...input, duration: 5 })).toThrow();
    expect(() => inputSchema.parse({ ...input, size: '16:9' })).toThrow();
    expect(() => inputSchema.parse({ ...basic, media: [{ durationMicros: 0 }] })).toThrow();
    expect(() => inputSchema.parse({ ...basic, duration: 31 })).toThrow();
    expect(() => inputSchema.parse({ ...basic, resolution: '4k' })).toThrow();
  });
  it('enforces the total video reference duration', async () => {
    const input = await editing();
    const id = input.references![0].assetId;
    const refs = [...input.references!];
    for (let i = 0; i < 6; i++) {
      const other = randomUUID();
      await pool.query(
        `INSERT INTO assets(id,scope,hash,name,kind,file_name,mime,bytes,duration_us,status,public_token,provider_url) SELECT $2::uuid,scope,$2::text,name,kind,file_name,mime,bytes,duration_us,status,public_token,provider_url FROM assets WHERE id=$1`,
        [id, other],
      );
      refs.push({ assetId: other, role: 'reference' });
    }
    await expect(estimate(pool, { ...input, references: refs })).rejects.toMatchObject({
      code: 'reference_limits',
    });
  });
  it('survives worker recreation and saves MOV with input seconds in settlement', async () => {
    const input = { ...(await editing()), outputFormat: 'mov' as const };
    const { id } = await createJob(pool, input, randomUUID(), 'mock', 1200);
    const provider = new MockProvider(pool, config.fixtureDir, 0);
    const submit = vi.spyOn(provider, 'submit');
    await new Worker(pool, config, { mock: provider }).runOnce();
    expect(submit.mock.calls[0][0]).toMatchObject({
      taskType: 'edit',
      duration: -1,
      outputFormat: 'mov',
      media: [{ kind: 'video', durationMicros: 4500000 }],
    });
    await pool.query('UPDATE jobs SET next_attempt_at=now() WHERE id=$1', [id]);
    await new Worker(pool, config, { mock: provider }).runOnce();
    const row = (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
    expect(row.status).toBe('completed');
    expect(row.result_file).toMatch(/\.mov$/);
    expect(row.charged_milli).toBe(23085);
    await migrate(pool, 123, 321);
    expect(
      (await pool.query('SELECT provider_input FROM jobs WHERE id=$1', [id])).rows[0].provider_input
        .outputFormat,
    ).toBe('mov');
  });
});

describe('Editing a saved generation', () => {
  async function completedVideo(short = false) {
    const { id } = await createJob(pool, { ...basic, duration: 5 }, randomUUID(), 'mock', 1200);
    const filename = `${id}.mp4`;
    await copyFile(
      join(config.fixtureDir, short ? 'demo-4.mp4' : 'demo-5.mp4'),
      join(config.storageDir, filename),
    );
    await settle(pool, id, {
      durationMicros: short ? 3_600_000 : 4_500_000,
      resultFile: filename,
      providerCostUsd: null,
      providerCreditsCost: null,
    });
    return { id, filename };
  }
  async function financialSnapshot() {
    return {
      users: (await pool.query('SELECT * FROM users ORDER BY id')).rows,
      jobs: (await pool.query('SELECT * FROM jobs ORDER BY id')).rows,
      ledger: (await pool.query('SELECT * FROM ledger ORDER BY id')).rows,
    };
  }
  it('reuses the local result and hash cache without creating a job or touching the wallet', async () => {
    const { id, filename } = await completedVideo();
    const before = await financialSnapshot();
    const app = await buildApp(pool, config, createProviders(pool, config));
    try {
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          app.inject({
            method: 'POST',
            url: `/api/jobs/${id}/edit-source`,
          }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      const source = results[0].json();
      expect(source).toMatchObject({ kind: 'video', durationSeconds: 4.5, status: 'ready' });
      expect(results[1].json().id).toBe(source.id);
      expect((await assets.ingest(createReadStream(fixture), 'video', 'reuploaded.mp4')).id).toBe(
        source.id,
      );
      expect((await pool.query('SELECT count(*) FROM assets')).rows[0].count).toBe('1');
      const preview = await app.inject({
        url: source.previewUrl,
        headers: { range: 'bytes=0-99' },
      });
      expect(preview.statusCode).toBe(206);
      expect(preview.rawPayload).toEqual((await readFile(fixture)).subarray(0, 100));
      expect(await readFile(join(config.storageDir, filename))).toEqual(await readFile(fixture));
      expect(
        await estimate(
          pool,
          {
            ...basic,
            taskType: 'edit',
            duration: -1,
            size: 'adaptive',
            references: [{ assetId: source.id, role: 'reference' }],
          },
          'mock',
        ),
      ).toMatchObject({ inputSeconds: 4.5, estimatedMilli: 25650 });
      expect(await financialSnapshot()).toEqual(before);
    } finally {
      await app.close();
    }
  });
  it('rejects unfinished, missing, invalid-path and too-short results without adding references', async () => {
    const pending = await createJob(pool, basic, randomUUID(), 'mock', 1200);
    const short = await completedVideo(true);
    const missing = await completedVideo();
    await pool.query('UPDATE jobs SET result_file=$2 WHERE id=$1', [missing.id, '../outside.mp4']);
    const app = await buildApp(pool, config, createProviders(pool, config));
    try {
      for (const id of [pending.id, randomUUID(), missing.id]) {
        expect(
          (await app.inject({ method: 'POST', url: `/api/jobs/${id}/edit-source` })).statusCode,
        ).toBe(404);
      }
      await pool.query('UPDATE jobs SET result_file=$2 WHERE id=$1', [
        missing.id,
        'missing-file.mp4',
      ]);
      expect(
        (await app.inject({ method: 'POST', url: `/api/jobs/${missing.id}/edit-source` }))
          .statusCode,
      ).toBe(404);
      const result = await app.inject({ method: 'POST', url: `/api/jobs/${short.id}/edit-source` });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('edit_duration');
      expect(
        (await app.inject({ method: 'POST', url: '/api/jobs/not-a-uuid/edit-source' })).statusCode,
      ).toBe(400);
      expect((await pool.query('SELECT count(*) FROM assets')).rows[0].count).toBe('0');
    } finally {
      await app.close();
    }
  });
  it('keeps real-mode sources local without a tunnel and does not reuse mock provider IDs', async () => {
    const { id } = await completedVideo();
    const mockSource = await assets.fromJob(id);
    const realConfig = {
      ...config,
      mode: 'apimart' as const,
      apiKey: 'test-edit-source-key',
      mediaBase: '',
    };
    const provider = new ApiMartAssets({
      apiKey: realConfig.apiKey,
      apiBase: 'https://api.apimart.ai',
    });
    const submit = vi.spyOn(provider, 'submit');
    const realAssets = new Assets(pool, realConfig, provider);
    const before = await financialSnapshot();
    const source = await realAssets.fromJob(id);
    expect(source.id).not.toBe(mockSource.id);
    expect(source.status).toBe('local');
    await realAssets.prepare(source.id);
    expect(submit).not.toHaveBeenCalled();
    expect((await realAssets.get(source.id)).error).toContain('MEDIA_BASE_URL');
    expect(await financialSnapshot()).toEqual(before);
    await realAssets.stop();
  });
});

describe('Media ingestion and public reference isolation', () => {
  it('caches identical bytes and measures duration without trusting the filename', async () => {
    const [first, second] = await Promise.all([
      assets.ingest(createReadStream(fixture), 'video', '../../source.mp4'),
      assets.ingest(createReadStream(fixture), 'video', 'renamed.mov'),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.durationSeconds).toBe(4.5);
    expect(first.status).toBe('ready');
    expect((await pool.query('SELECT count(*) FROM assets')).rows[0].count).toBe('1');
  });
  it('rejects corrupt and mismatched media and private URLs', async () => {
    await expect(
      assets.ingest(Readable.from('not a video'), 'video', 'test.mp4'),
    ).rejects.toMatchObject({ code: 'invalid_media' });
    await expect(
      assets.ingest(createReadStream(fixture), 'image', 'fake.png'),
    ).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(
      assets.ingest('https://127.0.0.1/secret', 'video', 'private'),
    ).rejects.toMatchObject({ code: 'reference_download' });
    expect((await pool.query('SELECT count(*) FROM assets')).rows[0].count).toBe('0');
  });
  it('accepts file upload, scopes previews, and exposes only expiring token URLs on the tunnel listener', async () => {
    const app = await buildApp(pool, config, createProviders(pool, config)),
      callback = await buildCallbackApp(
        pool,
        config,
        createProviders(pool, config, { APIMART_API_KEY: 'test-callback-key' }),
      );
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/api/assets/upload?kind=video&name=test.mp4',
        headers: { 'content-type': 'application/octet-stream' },
        payload: await readFile(fixture),
      });
      expect(result.statusCode).toBe(201);
      const a = result.json();
      expect(a.durationSeconds).toBe(4.5);
      expect((await app.inject(a.previewUrl)).statusCode).toBe(200);
      const {
        rows: [row],
      } = await pool.query('SELECT public_token FROM assets WHERE id=$1', [a.id]);
      const url = `/reference/${a.id}/${row.public_token}`;
      expect((await callback.inject(url)).statusCode).toBe(404);
      await pool.query("UPDATE assets SET public_until=now()+interval '1 hour' WHERE id=$1", [
        a.id,
      ]);
      const part = await callback.inject({ url, headers: { range: 'bytes=0-99' } });
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.length).toBe(100);
      expect((await callback.inject('/api/state')).statusCode).toBe(404);
      expect(
        (await callback.inject(url.replace(row.public_token, '0'.repeat(64)))).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
      await callback.close();
    }
  });
  it('keeps local video pending until a tunnel is configured', async () => {
    const realConfig = {
      ...config,
      mode: 'apimart' as const,
      apiKey: 'test-only-key',
      mediaBase: '',
    };
    const manager = new Assets(
      pool,
      realConfig,
      new ApiMartAssets({ apiKey: realConfig.apiKey, apiBase: 'https://api.apimart.ai' }),
    );
    const a = await manager.ingest(createReadStream(fixture), 'video', 'source.mp4');
    await manager.prepare(a.id);
    expect(await manager.get(a.id)).toMatchObject({
      status: 'local',
      error: expect.stringContaining('MEDIA_BASE_URL'),
    });
    expect(manager.scope).not.toContain(realConfig.apiKey);
  });
});

describe('APIMart contracts for advanced modes and asset moderation', () => {
  it('prepares a local video through the injected adapter, preserving the account cache and expiring tunnel URL', async () => {
    const realConfig = { ...config, mode: 'apimart', mediaBase: 'https://media.example.test' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, data: { id: 'moderation' } })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              id: 'moderation',
              status: 'completed',
              result: { asset_url: 'asset://approved_video' },
            },
          }),
        ),
      );
    const provider = new ApiMartAssets(
      { apiKey: 'test-preparation', apiBase: 'https://api.apimart.ai' },
      fetcher,
    );
    const manager = new Assets(pool, realConfig, provider);
    const source = await manager.ingest(createReadStream(fixture), 'video', 'reference.mp4');
    try {
      await manager.prepare(source.id);
      const row = (
        await pool.query('SELECT public_token,public_until,scope FROM assets WHERE id=$1', [
          source.id,
        ])
      ).rows[0];
      expect(row.scope).toBe(provider.scope);
      expect(row.public_until.getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(fetcher.mock.calls[0][0]).toBe(
        'https://api.apimart.ai/v1/seedance2/private-avatar/assets',
      );
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
        asset_type: 'Video',
        assets: [
          {
            url: `${realConfig.mediaBase}/reference/${source.id}/${row.public_token}`,
            name: 'reference.mp4',
          },
        ],
      });
      await pool.query('UPDATE assets SET next_attempt_at=now() WHERE id=$1', [source.id]);
      await manager.prepare(source.id);
      expect(await manager.get(source.id)).toMatchObject({ status: 'ready', error: null });
      expect(
        (await pool.query('SELECT provider_url FROM assets WHERE id=$1', [source.id])).rows[0]
          .provider_url,
      ).toBe('asset://approved_video');
      expect((await pool.query('SELECT count(*) FROM ledger')).rows[0].count).toBe('0');
    } finally {
      await manager.stop();
    }
  });
  it.each(['edit', 'extend', 'reference', 'frames'] as const)(
    'sends the documented %s fields and keeps the key',
    async (taskType) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 200, data: [{ task_id: 'task' }] })),
        );
      const provider = new ApiMartProvider(
        { apiKey: 'test-key', baseUrl: 'https://api.apimart.ai', timeoutMs: 1000, webhookBase: '' },
        fetcher,
      );
      const input: ProviderInput = {
        ...basic,
        taskType,
        duration: taskType === 'edit' ? -1 : 12,
        resolution: '1080p',
        size: 'adaptive',
        outputFormat: 'mov',
        generateAudio: false,
        seed: 12,
        watermark: true,
        media:
          taskType === 'frames'
            ? [
                { kind: 'image', role: 'first_frame', url: 'asset://image1', durationMicros: 0 },
                { kind: 'image', role: 'last_frame', url: 'asset://image2', durationMicros: 0 },
              ]
            : [
                { kind: 'video', role: 'reference', url: 'asset://video', durationMicros: 4500000 },
                { kind: 'audio', role: 'reference', url: 'asset://audio', durationMicros: 4000000 },
              ],
      };
      await provider.submit(input, 'stable-id');
      const request = fetcher.mock.calls[0][1],
        body = JSON.parse(request.body);
      expect(request.headers['Idempotency-Key']).toBe('stable-id');
      expect(body).toMatchObject({
        resolution: '1080p',
        duration: input.duration,
        size: 'adaptive',
        output_format: 'mov',
        generate_audio: false,
        seed: 12,
        watermark: true,
      });
      if (taskType === 'frames') {
        expect(body.image_with_roles).toHaveLength(2);
        expect(body.video_urls).toBeUndefined();
      } else {
        expect(body.omni_reference_task_type).toBe(taskType);
        expect(body.video_urls).toEqual(['asset://video']);
        expect(body.audio_urls).toEqual(['asset://audio']);
      }
    },
  );
  it('accepts only approved asset references returned for the matching moderation task', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 200, data: { id: 'moderation', status: 'processing' } }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              id: 'moderation',
              status: 'completed',
              result: { usable_assets: [{ asset_url: 'asset://approved_123', status: 'Active' }] },
            },
          }),
        ),
      );
    const provider = new ApiMartAssets(
      { apiKey: 'test', apiBase: 'https://api.apimart.ai' },
      fetcher,
    );
    expect(await provider.submit('https://media.example/video.mp4', 'video', 'source')).toBe(
      'moderation',
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      model: 'seedance-2.5',
      asset_type: 'Video',
    });
    expect(await provider.poll('moderation')).toEqual({
      status: 'ready',
      url: 'asset://approved_123',
    });
  });
});
