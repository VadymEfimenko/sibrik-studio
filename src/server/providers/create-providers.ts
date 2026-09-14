import type { Config } from '../config.js';
import type { Database } from '../db/connection.js';
import { createApiMartProvider } from './apimart-factory.js';
import { MockProvider } from './mock.js';
import { requireProvider, type ProviderRegistry, type VideoProvider } from './types.js';

export type ProviderFactory = (context: {
  pool: Database;
  config: Config;
  env: NodeJS.ProcessEnv;
}) => VideoProvider | undefined;

/** Add a new adapter factory here; business logic and persisted IDs stay unchanged. */
const factories: Readonly<Record<string, ProviderFactory>> = {
  mock: ({ pool, config }) => new MockProvider(pool, config.fixtureDir),
  apimart: createApiMartProvider,
};

/** Production adapters are assembled at the process entry points; tests inject their own. */
export function createProviders(
  pool: Database,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  registeredFactories = factories,
): ProviderRegistry {
  if (!Object.hasOwn(registeredFactories, config.mode))
    throw new Error(`Provider '${config.mode}' is not registered`);
  const providers: Record<string, VideoProvider | undefined> = Object.create(null);
  for (const [id, factory] of Object.entries(registeredFactories))
    providers[id] = factory({ pool, config, env });
  requireProvider(providers, config.mode);
  return providers;
}
