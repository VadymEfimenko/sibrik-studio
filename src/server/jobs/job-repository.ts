import { randomUUID } from 'node:crypto';
import type { JobStatus, ProviderInput } from '../../shared/contracts.js';
import { type Database, notify, transaction } from '../db/connection.js';
import type { ProviderStatus } from '../providers/types.js';

export interface WorkItem {
  id: string;
  mode: string;
  status: JobStatus;
  provider_task_id: string | null;
  prompt: string;
  requested_duration: number;
  provider_input: ProviderInput | null;
  model_id: 'seedance-2.5';
  resolution: ProviderInput['resolution'];
  lease_token: string;
  deadline_at: Date;
  /** Persisted as poll_attempt for compatibility; counts every worker transition. */
  processing_attempt: number;
  download_attempt: number;
  last_webhook_at: Date | null;
}
interface Transition {
  status: JobStatus;
  delay?: number;
  cooldown?: boolean;
  code?: string | null;
  message?: string | null;
  taskId?: string;
  progress?: number | null;
  cost?: string | null;
  credits?: string | null;
  downloadAttempt?: number;
}

/** Queue persistence only. Wallet and ledger operations stay in billing transactions. */
export class JobRepository {
  constructor(private pool: Database) {}

  async claim(): Promise<WorkItem | undefined> {
    const { rows } = await this.pool.query<WorkItem>(
      `WITH candidate AS (
        SELECT id FROM jobs WHERE financial_status='held'
          AND (next_attempt_at<=now() OR deadline_at<=now()) AND (lease_until IS NULL OR lease_until<=now())
          AND (retry_not_before IS NULL OR retry_not_before<=now() OR deadline_at<=now())
        ORDER BY LEAST(next_attempt_at,deadline_at),created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE jobs j SET lease_token=$1,lease_until=now()+interval '120 seconds'
        FROM candidate c WHERE j.id=c.id RETURNING j.*,j.poll_attempt AS processing_attempt`,
      [randomUUID()],
    );
    return rows[0];
  }

  async renewLease(job: WorkItem): Promise<void> {
    await this.pool.query(
      "UPDATE jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND financial_status='held'",
      [job.id, job.lease_token],
    );
  }

  waitForConfiguration(job: WorkItem) {
    return this.transition(job, {
      status: job.status,
      delay: 30000,
      code: 'provider_unconfigured',
      message: 'Очікуємо на налаштування ключа провайдера.',
    });
  }
  markSubmitting(job: WorkItem) {
    return this.transition(job, { status: 'submitting' }, false);
  }
  markSubmitted(job: WorkItem, taskId: string) {
    return this.transition(job, {
      status: 'pending',
      taskId,
      delay: job.mode === 'mock' ? 500 : 5000,
    });
  }
  markSubmissionUnknown(job: WorkItem, message: string) {
    return this.transition(job, {
      status: 'submission_unknown',
      delay: 30000,
      code: 'submission_unknown',
      message,
    });
  }
  retrySubmission(job: WorkItem, delay: number, error: { code: string; message: string }) {
    return this.transition(job, {
      status: 'queued',
      delay,
      cooldown: true,
      code: error.code,
      message: error.message,
    });
  }
  recordProviderFailure(job: WorkItem, state: ProviderStatus) {
    return this.transition(
      job,
      { status: job.status, cost: state.costUsd, credits: state.creditsCost },
      false,
    );
  }
  recordProgress(
    job: WorkItem,
    state: ProviderStatus & { state: 'pending' | 'processing' },
    delay: number,
  ) {
    return this.transition(job, {
      status: state.state,
      progress: state.progress,
      cost: state.costUsd,
      credits: state.creditsCost,
      delay,
    });
  }
  beginDownload(job: WorkItem, state: ProviderStatus) {
    return this.transition(
      job,
      { status: 'downloading', progress: 100, cost: state.costUsd, credits: state.creditsCost },
      false,
    );
  }
  retryDownload(
    job: WorkItem,
    delay: number,
    error: { code: string; message: string },
    downloadAttempt?: number,
  ) {
    return this.transition(job, {
      status: 'downloading',
      delay,
      cooldown: true,
      code: error.code,
      message: error.message,
      downloadAttempt,
    });
  }
  retryPoll(job: WorkItem, delay: number) {
    return this.transition(job, {
      status: job.status === 'downloading' ? 'downloading' : 'pending',
      delay,
      cooldown: true,
      code: 'provider_retry',
      message: 'Провайдер тимчасово недоступний. Продовжуємо очікувати.',
    });
  }

  private transition(job: WorkItem, values: Transition, unlock = true): Promise<boolean> {
    // A named record keeps SQL and values together without a long positional parameter list.
    const change = {
      status: values.status,
      delay_ms: values.delay ?? 0,
      error_code: values.code ?? null,
      error_message: values.message ?? null,
      task_id: values.taskId ?? null,
      progress: values.progress ?? null,
      download_attempt: values.downloadAttempt ?? null,
      previous_webhook_at: job.last_webhook_at,
      cost_usd: values.cost ?? null,
      credits_cost: values.credits ?? null,
      unlock,
      cooldown: values.cooldown ?? false,
    };
    return transaction(this.pool, async (tx) => {
      const { rowCount } = await tx.query(
        `WITH change AS (
          SELECT * FROM jsonb_to_record($3::jsonb) AS v(
            status text, delay_ms integer, error_code text, error_message text, task_id text,
            progress integer, download_attempt integer, previous_webhook_at timestamptz,
            cost_usd numeric, credits_cost numeric, unlock boolean, cooldown boolean
          )
        ) UPDATE jobs j SET status=v.status,updated_at=now(),
          next_attempt_at=CASE WHEN j.last_webhook_at IS NOT NULL AND
            (v.previous_webhook_at IS NULL OR j.last_webhook_at>v.previous_webhook_at)
            THEN now() ELSE now()+v.delay_ms*interval '1 millisecond' END,
          error_code=v.error_code,error_message=v.error_message,
          provider_task_id=COALESCE(v.task_id,j.provider_task_id),
          progress=COALESCE(v.progress,j.progress),poll_attempt=j.poll_attempt+1,
          download_attempt=COALESCE(v.download_attempt,j.download_attempt),
          provider_cost_usd=COALESCE(v.cost_usd,j.provider_cost_usd),
          provider_credits_cost=COALESCE(v.credits_cost,j.provider_credits_cost),
          lease_token=CASE WHEN v.unlock THEN NULL ELSE j.lease_token END,
          lease_until=CASE WHEN v.unlock THEN NULL ELSE j.lease_until END,
          retry_not_before=CASE WHEN v.cooldown THEN now()+v.delay_ms*interval '1 millisecond' ELSE NULL END
        FROM change v
        WHERE j.id=$1 AND j.lease_token=$2 AND j.lease_until>now() AND j.financial_status='held'`,
        [job.id, job.lease_token, JSON.stringify(change)],
      );
      if (rowCount) await notify(tx);
      return !!rowCount;
    });
  }
}
