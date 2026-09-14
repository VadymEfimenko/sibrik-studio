import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { Assets } from '../assets/service.js';
import { createJob, estimate } from '../billing/credits.js';
import type { Config } from '../config.js';
import type { Database } from '../db/connection.js';
import { AppError } from '../errors.js';
import { requireProvider, type ProviderRegistry } from '../providers/types.js';
import { inputSchema } from '../jobs/input.js';
import { createHttpApp } from './create-http-app.js';
import { Events } from './events.js';
import { readState } from './state.js';

const uuid = z.string().uuid();
export async function buildApp(pool: Database, config: Config, providers: ProviderRegistry) {
  const app = createHttpApp(config);
  const provider = requireProvider(providers, config.mode);
  const assets = new Assets(pool, config, provider.assets);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  // The assignment has one seeded user and no login. Keep the main listener local.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return;
    const origin = request.headers.origin;
    if (
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (origin && new URL(origin).host !== request.headers.host)
    ) {
      return reply
        .code(403)
        .send({ error: { code: 'cross_origin', message: 'Запит з іншого сайту відхилено.' } });
    }
  });
  const clientDir = resolve('dist/client');
  await app.register(fastifyStatic, {
    root: clientDir,
    serve: existsSync(clientDir),
    index: ['index.html'],
    wildcard: false,
    dotfiles: 'deny',
  });
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, mode: config.mode };
  });
  app.get('/api/state', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readState(pool, config, provider);
  });
  app.post('/api/estimate', async (request) =>
    estimate(pool, inputSchema.parse(request.body), assets.scope),
  );
  app.post(
    '/api/jobs',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = inputSchema.parse(request.body);
      const key = uuid.parse(request.headers['idempotency-key']);
      const result = await createJob(
        pool,
        input,
        key,
        config.mode,
        config.timeoutSeconds,
        assets.scope,
      );
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  );
  const assetQuery = z.object({
    kind: z.enum(['image', 'video', 'audio']),
    name: z.string().max(180).default('Референс'),
  });
  app.post(
    '/api/assets/upload',
    { bodyLimit: 200 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = assetQuery.parse(request.query);
      if (request.headers['content-type'] !== 'application/octet-stream')
        throw new AppError(415, 'file_type', 'Завантажте файл як application/octet-stream.');
      const asset = await assets.ingest(request.body as Readable, query.kind, query.name);
      return reply.code(201).send(asset);
    },
  );
  app.post(
    '/api/assets/import',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = assetQuery
        .extend({ url: z.string().url().max(4096) })
        .strict()
        .parse(request.body);
      return reply.code(201).send(await assets.ingest(input.url, input.kind, input.name));
    },
  );
  app.get('/api/assets', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return assets.list();
  });
  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/edit-source',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => assets.fromJob(uuid.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/assets/:id/retry', async (request) =>
    assets.retry(uuid.parse(request.params.id)),
  );
  app.get<{ Params: { id: string } }>('/api/assets/:id/media', async (request, reply) => {
    const {
      rows: [asset],
    } = await pool.query('SELECT file_name,mime FROM assets WHERE id=$1 AND scope=$2', [
      uuid.parse(request.params.id),
      assets.scope,
    ]);
    if (!asset || basename(asset.file_name) !== asset.file_name) return reply.code(404).send();
    reply.type(asset.mime).header('Cache-Control', 'private, max-age=86400');
    return reply.sendFile(asset.file_name, join(config.storageDir, 'references'));
  });
  const events = new Events(config.databaseUrl);
  await events.start();
  app.get('/api/events', async (request, reply) => {
    if (request.raw.destroyed) return;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    events.add(reply.raw);
  });
  app.get<{ Params: { id: string } }>('/media/:id', async (request, reply) => {
    const id = uuid.parse(request.params.id);
    const {
      rows: [job],
    } = await pool.query(
      "SELECT result_file FROM jobs WHERE id=$1 AND status='completed' AND financial_status='settled'",
      [id],
    );
    if (!job?.result_file || basename(job.result_file) !== job.result_file)
      return reply.code(404).send({ error: { message: 'Відео не знайдено.' } });
    reply
      .header('Cache-Control', 'private, max-age=86400')
      .type(job.result_file.endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
    return reply.sendFile(job.result_file, config.storageDir);
  });
  app.addHook('preClose', async () => events.stop());
  app.addHook('onClose', async () => assets.stop());
  return app;
}
