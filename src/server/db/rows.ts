import type {
  AssetKind,
  FinancialStatus,
  JobStatus,
  LedgerKind,
  ProviderInput,
  StudioAsset,
} from '../../shared/contracts.js';

// PostgreSQL returns bigint/numeric as strings and timestamptz as Date by default.
export interface WalletRow {
  id: number;
  initial_milli: number;
  available_milli: number;
  held_milli: number;
}
export interface ModelRow {
  id: 'seedance-2.5';
  name: string;
  rate_milli: number;
  rate_720_milli: number;
  rate_1080_milli: number;
}
export interface JobRow {
  id: string;
  user_id: number;
  model_id: 'seedance-2.5';
  mode: string;
  idempotency_key: string;
  fingerprint: string;
  prompt: string;
  requested_duration: number;
  resolution: ProviderInput['resolution'];
  provider_input: ProviderInput | null;
  input_duration_us: string;
  status: JobStatus;
  financial_status: FinancialStatus;
  rate_milli: number;
  estimate_milli: number;
  hold_milli: number;
  actual_duration_us: string | null;
  actual_cost_milli: number | null;
  charged_milli: number;
  released_milli: number;
  absorbed_milli: number;
  provider_task_id: string | null;
  provider_cost_usd: string | null;
  provider_credits_cost: string | null;
  progress: number | null;
  result_file: string | null;
  error_code: string | null;
  error_message: string | null;
  poll_attempt: number;
  download_attempt: number;
  lease_token: string | null;
  lease_until: Date | null;
  next_attempt_at: Date;
  retry_not_before: Date | null;
  last_webhook_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  deadline_at: Date;
}
export interface LedgerRow {
  id: string;
  job_id: string;
  kind: LedgerKind;
  amount_milli: number;
  available_delta_milli: number;
  held_delta_milli: number;
  available_after_milli: number;
  held_after_milli: number;
  created_at: Date;
  note: string;
}
export interface AssetRow {
  id: string;
  scope: string;
  hash: string;
  name: string;
  kind: AssetKind;
  file_name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_us: string;
  source_url: string | null;
  status: StudioAsset['status'];
  provider_url: string | null;
  provider_task_id: string | null;
  error_message: string | null;
  moderation_started_at: Date | null;
  public_token: string;
  public_until: Date | null;
  lease_until: Date | null;
  next_attempt_at: Date;
  created_at: Date;
}
