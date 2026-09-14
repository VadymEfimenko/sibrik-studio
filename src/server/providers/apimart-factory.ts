import { ApiMartProvider } from './apimart.js';
import type { ProviderFactory } from './create-providers.js';

/** All APIMart-specific settings stay at the adapter boundary. */
export const createApiMartProvider: ProviderFactory = ({ config, env }) => {
  const apiKey = env.APIMART_API_KEY || '';
  if (!apiKey) {
    if (config.mode === 'apimart') throw new Error('APIMART_API_KEY is required in apimart mode');
    return undefined;
  }
  const base = new URL(env.APIMART_BASE_URL || 'https://api.apimart.ai');
  if (base.protocol !== 'https:' || base.username || base.password)
    throw new Error('APIMART_BASE_URL must use HTTPS');
  return new ApiMartProvider({
    apiKey,
    baseUrl: base.origin,
    timeoutMs: config.httpTimeoutMs,
    webhookBase: config.webhookBase,
  });
};
