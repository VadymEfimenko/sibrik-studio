import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/connection.js';
import type { ProviderRegistry } from '../providers/types.js';
import { createHttpApp } from './create-http-app.js';

const uuid = z.string().uuid();
export async function buildCallbackApp(
  pool: Database,
  config: Config,
  providers: ProviderRegistry,
) {
  const app = createHttpApp(config);
  await app.register(fastifyStatic, { root: join(config.storageDir, 'references'), serve: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.get<{ Params: { id: string; token: string } }>(
    '/reference/:id/:token',
    async (request, reply) => {
      const id = uuid.parse(request.params.id);
      const token = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(request.params.token);
      const {
        rows: [asset],
      } = await pool.query(
        'SELECT file_name,mime FROM assets WHERE id=$1 AND public_token=$2 AND public_until>now()',
        [id, token],
      );
      if (!asset || basename(asset.file_name) !== asset.file_name) return reply.code(404).send();
      reply.type(asset.mime).header('Cache-Control', 'private, no-store');
      return reply.sendFile(asset.file_name, join(config.storageDir, 'references'));
    },
  );
  for (const [providerId, provider] of Object.entries(providers)) {
    const webhook = provider?.webhook;
    if (!webhook) continue;
    app.post(webhook.path, async (request) => {
      const id = webhook.taskId(request.body, request.headers);
      // Unknown, repeated and late callbacks are acknowledged without any financial effects.
      // Persist the wake-up BEFORE 2xx; authenticated provider GET remains authoritative.
      if (id)
        await pool.query(
          `UPDATE jobs SET next_attempt_at=now(),last_webhook_at=now()
      WHERE provider_task_id=$1 AND mode=$2 AND financial_status='held'
      AND (last_webhook_at IS NULL OR last_webhook_at<now()-interval '5 seconds')`,
          [id, providerId],
        );
      return { received: true };
    });
  }
  return app;
}
