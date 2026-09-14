import { createHash, randomUUID } from 'node:crypto';
import type { Estimate, GenerateInput } from '../../shared/contracts.js';
import { type Database, notify, type Transaction, transaction } from '../db/connection.js';
import type { JobRow, WalletRow } from '../db/rows.js';
import { AppError } from '../errors.js';
import { inputSchema } from '../jobs/input.js';
import { costForMicros } from './money.js';
import { quoteInput } from './quote.js';

export async function estimate(
  pool: Database,
  input: GenerateInput,
  scope?: string,
): Promise<Estimate> {
  return (await quoteInput(pool, input, scope)).quote;
}

async function ledger(
  tx: Transaction,
  jobId: string,
  kind: 'hold' | 'settle' | 'release',
  amount: number,
  note: string,
) {
  if (amount === 0) return;
  const availableDelta = kind === 'hold' ? -amount : kind === 'release' ? amount : 0;
  const heldDelta = kind === 'hold' ? amount : -amount;
  const {
    rows: [wallet],
  } = await tx.query<WalletRow>(
    'UPDATE users SET available_milli=available_milli+$1,held_milli=held_milli+$2 WHERE id=1 RETURNING *',
    [availableDelta, heldDelta],
  );
  await tx.query(
    `INSERT INTO ledger(user_id,job_id,kind,amount_milli,available_delta_milli,held_delta_milli,available_after_milli,held_after_milli,note)
    VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      jobId,
      kind,
      amount,
      availableDelta,
      heldDelta,
      wallet.available_milli,
      wallet.held_milli,
      note,
    ],
  );
}

export async function createJob(
  pool: Database,
  input: GenerateInput,
  key: string,
  mode: string,
  timeoutSeconds: number,
  scope?: string,
) {
  const normalized = inputSchema.parse(input);
  const basic =
    normalized.taskType === 'generate' &&
    normalized.size === '16:9' &&
    normalized.outputFormat === 'mp4' &&
    normalized.generateAudio &&
    !normalized.watermark &&
    normalized.seed === undefined &&
    !normalized.references.length;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        basic
          ? [normalized.modelId, normalized.prompt, normalized.duration, normalized.resolution]
          : normalized,
      ),
    )
    .digest('hex');
  return transaction(pool, async (tx) => {
    const {
      rows: [wallet],
    } = await tx.query<WalletRow>('SELECT * FROM users WHERE id=1 FOR UPDATE');
    // Idempotent retries still work when the first request used the last credits.
    const {
      rows: [previous],
    } = await tx.query<JobRow>('SELECT * FROM jobs WHERE user_id=1 AND idempotency_key=$1', [key]);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          409,
          'idempotency_conflict',
          'Цей ключ запиту вже використано з іншими параметрами.',
        );
      return { id: previous.id, created: false };
    }
    const { input: providerInput, quote } = await quoteInput(tx, normalized, scope);
    const hold = quote.holdMilli;
    if (wallet.available_milli < hold)
      throw new AppError(
        402,
        'insufficient_credits',
        'Недостатньо доступних кредитів для цієї генерації.',
      );
    const id = randomUUID();
    await tx.query(
      `INSERT INTO jobs(id,user_id,model_id,mode,idempotency_key,fingerprint,prompt,requested_duration,resolution,rate_milli,hold_milli,deadline_at,estimate_milli,provider_input,input_duration_us)
      VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+$11*interval '1 second',$12,$13,$14)`,
      [
        id,
        input.modelId,
        mode,
        key,
        fingerprint,
        normalized.prompt,
        input.duration,
        input.resolution,
        quote.rateMilli,
        hold,
        timeoutSeconds,
        quote.estimatedMilli,
        JSON.stringify(providerInput),
        Math.round(quote.inputSeconds * 1e6),
      ],
    );
    await ledger(tx, id, 'hold', hold, 'Credit hold before generation');
    await notify(tx);
    return { id, created: true };
  });
}

export interface Settlement {
  durationMicros: number;
  resultFile: string;
  providerCostUsd: string | null;
  providerCreditsCost: string | null;
}

export async function settle(
  pool: Database,
  jobId: string,
  result: Settlement,
  leaseToken?: string,
): Promise<boolean> {
  return transaction(pool, async (tx) => {
    await tx.query('SELECT id FROM users WHERE id=1 FOR UPDATE');
    const {
      rows: [job],
    } = await tx.query<JobRow>('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [jobId]);
    if (!job || job.financial_status !== 'held') return false;
    if (
      leaseToken &&
      (job.lease_token !== leaseToken || (job.lease_until?.getTime() ?? 0) <= Date.now())
    )
      return false;
    if (job.deadline_at.getTime() <= Date.now()) {
      await releaseLocked(
        tx,
        job,
        'timed_out',
        'job_timeout',
        'Час очікування минув. Резерв повернено.',
      );
      return false;
    }
    const actual = costForMicros(
      result.durationMicros + Number(job.input_duration_us),
      job.rate_milli,
    );
    const charged = Math.min(actual, job.hold_milli);
    const returned = job.hold_milli - charged;
    await tx.query(
      `UPDATE jobs SET status='completed',financial_status='settled',actual_duration_us=$2,actual_cost_milli=$3,
      charged_milli=$4,released_milli=$5,absorbed_milli=$6,result_file=$7,
      provider_cost_usd=COALESCE($8,provider_cost_usd),provider_credits_cost=COALESCE($9,provider_credits_cost),
      progress=100,error_code=NULL,error_message=NULL,completed_at=now(),updated_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1`,
      [
        jobId,
        result.durationMicros,
        actual,
        charged,
        returned,
        actual - charged,
        result.resultFile,
        result.providerCostUsd,
        result.providerCreditsCost,
      ],
    );
    await ledger(
      tx,
      jobId,
      'settle',
      charged,
      'Settlement based on verified input and output video duration',
    );
    await ledger(tx, jobId, 'release', returned, 'Release of unused credit hold');
    await notify(tx);
    return true;
  });
}

async function releaseLocked(
  tx: Transaction,
  job: { id: string; hold_milli: number },
  status: 'failed' | 'timed_out',
  code: string,
  message: string,
) {
  await tx.query(
    `UPDATE jobs SET status=$2,financial_status='released',released_milli=hold_milli,error_code=$3,error_message=$4,
    completed_at=now(),updated_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1`,
    [job.id, status, code, message],
  );
  await ledger(
    tx,
    job.id,
    'release',
    job.hold_milli,
    status === 'timed_out' ? 'Refund: job timed out' : 'Refund: generation did not complete',
  );
  await notify(tx);
}

export async function release(
  pool: Database,
  jobId: string,
  code: string,
  message: string,
  status: 'failed' | 'timed_out' = 'failed',
  leaseToken?: string,
): Promise<boolean> {
  return transaction(pool, async (tx) => {
    await tx.query('SELECT id FROM users WHERE id=1 FOR UPDATE');
    const {
      rows: [job],
    } = await tx.query<JobRow>('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [jobId]);
    if (!job || job.financial_status !== 'held') return false;
    if (
      leaseToken &&
      (job.lease_token !== leaseToken || (job.lease_until?.getTime() ?? 0) <= Date.now())
    )
      return false;
    await releaseLocked(tx, job, status, code, message);
    return true;
  });
}
