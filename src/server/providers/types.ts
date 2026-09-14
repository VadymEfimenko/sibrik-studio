import type { AssetKind, ProviderInput } from '../../shared/contracts.js';

export interface ProviderStatus {
  state: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number | null;
  errorCode?: string;
  errorMessage?: string;
  costUsd: string | null;
  creditsCost: string | null;
}
export interface ProviderResult {
  source: { kind: 'url'; url: string } | { kind: 'file'; path: string };
  costUsd: string | null;
  creditsCost: string | null;
}
export interface VideoProvider {
  readonly displayName?: string;
  readonly assets?: AssetProvider;
  /** Optional fallback interval when this adapter has enabled webhooks. */
  readonly pollIntervalMs?: number;
  readonly webhook?: {
    path: string;
    taskId(body: unknown, headers: Record<string, string | string[] | undefined>): string | null;
  };
  /** A persisted job ID, stable across worker restarts and retries of the same submission. */
  submit(input: ProviderInput, idempotencyKey: string): Promise<{ taskId: string }>;
  poll(taskId: string): Promise<ProviderStatus>;
  result(taskId: string): Promise<ProviderResult>;
}

export type ProviderRegistry = Readonly<Record<string, VideoProvider | undefined>>;

export interface AssetInput {
  id: string;
  path: string;
  mime: string;
  kind: AssetKind;
  name: string;
  sourceUrl: string | null;
  /** Publishes the local file with an expiring token only if the adapter needs it. */
  publish(): Promise<string | null>;
}

export type AssetPreparation =
  | { status: 'local'; message: string }
  | { status: 'processing'; taskId: string }
  | { status: 'ready'; url: string };

export type AssetStatus =
  { status: 'processing' } | { status: 'ready'; url: string } | { status: 'failed' };

export interface AssetProvider {
  /** Stable namespace unique to the provider/account; never include a raw credential. */
  readonly scope: string;
  readonly requiresPublicMedia: boolean;
  /** Adapters using files directly can bypass remote preparation (for example, mock). */
  localUrl?(id: string): string;
  prepare(input: AssetInput): Promise<AssetPreparation>;
  poll(taskId: string): Promise<AssetStatus>;
}

export function requireProvider(providers: ProviderRegistry, id: string): VideoProvider {
  const provider = Object.hasOwn(providers, id) ? providers[id] : undefined;
  if (!provider) throw new Error(`Provider '${id}' is not registered or configured`);
  return provider;
}
