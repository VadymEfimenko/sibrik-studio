export type JobStatus =
  | 'queued'
  | 'submitting'
  | 'submission_unknown'
  | 'pending'
  | 'processing'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'timed_out';
export type FinancialStatus = 'held' | 'settled' | 'released';
export type LedgerKind = 'hold' | 'settle' | 'release';
export const resolutions = ['480p', '720p', '1080p'] as const;
export const aspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const;
export type Resolution = (typeof resolutions)[number];
export type TaskType = 'generate' | 'reference' | 'frames' | 'edit' | 'extend';
export type AssetKind = 'image' | 'video' | 'audio';
export type AssetRole = 'reference' | 'first_frame' | 'last_frame';
export interface AssetSelection {
  assetId: string;
  role: AssetRole;
}
export interface StudioAsset {
  id: string;
  name: string;
  kind: AssetKind;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  bytes: number;
  status: 'local' | 'processing' | 'ready' | 'failed';
  error: string | null;
  previewUrl: string;
  createdAt: string;
}
export interface GenerateInput {
  prompt: string;
  duration: number;
  resolution: Resolution;
  modelId: 'seedance-2.5';
  taskType?: TaskType;
  size?: (typeof aspectRatios)[number];
  outputFormat?: 'mp4' | 'mov';
  generateAudio?: boolean;
  seed?: number;
  watermark?: boolean;
  references?: AssetSelection[];
}
/** Only the server resolves local asset IDs to immutable provider references. */
export interface ProviderInput extends GenerateInput {
  media?: { kind: AssetKind; role: AssetRole; url: string; durationMicros: number }[];
  expectedDurationSeconds?: number;
}
export interface Wallet {
  availableMilli: number;
  heldMilli: number;
  spentMilli: number;
  initialMilli: number;
}
export interface Estimate {
  estimatedMilli: number;
  holdMilli: number;
  rateMilli: number;
  duration: number;
  resolution: Resolution;
  modelId: string;
  currency: 'credits';
  capAtHold: true;
  inputSeconds: number;
  expectedOutputSeconds: number;
  reservedOutputSeconds: number;
  automaticDuration: boolean;
}
export interface GenerationJob {
  id: string;
  prompt: string;
  duration: number;
  resolution: string;
  modelId: string;
  status: JobStatus;
  financialStatus: FinancialStatus;
  progress: number | null;
  rateMilli: number;
  estimateMilli: number;
  holdMilli: number;
  actualDurationSeconds: number | null;
  actualCostMilli: number | null;
  chargedMilli: number | null;
  releasedMilli: number | null;
  absorbedMilli: number | null;
  videoUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerCostUsd: string | null;
  providerCreditsCost: string | null;
  createdAt: string;
  completedAt: string | null;
  deadlineAt: string;
  mode: string;
  taskType: TaskType;
  size: string;
  outputFormat: 'mp4' | 'mov';
  inputSeconds: number;
}
export interface LedgerEntry {
  id: string;
  jobId: string;
  kind: LedgerKind;
  amountMilli: number;
  availableDeltaMilli: number;
  heldDeltaMilli: number;
  availableAfterMilli: number;
  heldAfterMilli: number;
  createdAt: string;
  note: string;
}
export interface StudioState {
  providerName: string;
  wallet: Wallet;
  jobs: GenerationJob[];
  ledger: LedgerEntry[];
  model: {
    id: 'seedance-2.5';
    name: string;
    rateMilli: number;
    durations: number[];
    resolutions: Resolution[];
    rates: Record<Resolution, number>;
  };
  mode: string;
  transport: 'polling' | 'webhook';
}
