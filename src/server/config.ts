import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { creditsToMilli } from './billing/money.js';

if (existsSync('.env')) process.loadEnvFile('.env');

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.PROVIDER_MODE || 'mock';
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(mode))
    throw new Error(
      'PROVIDER_MODE must be a provider identifier (1–64 lowercase letters, digits, _ or -)',
    );
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('DATABASE_URL is required. Use npm run dev for an automatic local database.');
  const webhookBase = env.WEBHOOK_BASE_URL || '';
  const mediaBase = env.MEDIA_BASE_URL || '';
  if (mediaBase) {
    const url = new URL(mediaBase);
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('MEDIA_BASE_URL must be a public HTTPS origin, without a path or query');
  }
  if (webhookBase) {
    const url = new URL(webhookBase);
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error('WEBHOOK_BASE_URL must be a public HTTPS origin, without a path or query');
    }
  }
  return {
    mode,
    databaseUrl,
    webhookBase: webhookBase.replace(/\/$/, ''),
    mediaBase: mediaBase.replace(/\/$/, ''),
    port: integer(env, 'PORT', 3000, 1024, 65535),
    callbackPort: integer(env, 'CALLBACK_PORT', 3001, 1024, 65535),
    initialMilli: creditsToMilli(env.INITIAL_CREDITS || '100'),
    rateMilli: creditsToMilli(env.CREDITS_PER_SECOND || '2.85'),
    timeoutSeconds: integer(env, 'JOB_TIMEOUT_SECONDS', 1200, 30, 86400),
    httpTimeoutMs: integer(env, 'PROVIDER_HTTP_TIMEOUT_SECONDS', 30, 1, 120) * 1000,
    concurrency: integer(env, 'WORKER_CONCURRENCY', 2, 1, 8),
    embeddedWorker: env.WORKER_EMBEDDED !== 'false',
    storageDir: resolve(env.STORAGE_DIR || './storage'),
    fixtureDir: resolve(env.FIXTURE_DIR || './public/demo'),
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    logLevel: env.LOG_LEVEL || 'info',
  } as const;
}
export type Config = ReturnType<typeof loadConfig>;
