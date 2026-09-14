import type { StudioState } from '../../shared/contracts.js';
import type { VideoProvider } from '../providers/types.js';
import type { Config } from '../config.js';
import { transaction, type Database } from '../db/connection.js';
import type { JobRow, LedgerRow, ModelRow, WalletRow } from '../db/rows.js';

export async function readState(
  pool: Database,
  config: Pick<Config, 'mode' | 'webhookBase'>,
  provider: VideoProvider,
): Promise<StudioState> {
  return transaction(pool, async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {
      rows: [wallet],
    } = await tx.query<WalletRow>('SELECT * FROM users WHERE id=1');
    const {
      rows: [model],
    } = await tx.query<ModelRow>("SELECT * FROM models WHERE id='seedance-2.5'");
    const { rows: jobs } = await tx.query<JobRow>(
      'SELECT * FROM jobs WHERE user_id=1 ORDER BY created_at DESC LIMIT 100',
    );
    const { rows: ledger } = await tx.query<LedgerRow>(
      'SELECT * FROM ledger WHERE user_id=1 ORDER BY id DESC LIMIT 150',
    );
    return {
      mode: config.mode,
      providerName: provider.displayName || config.mode,
      transport: config.webhookBase && provider.webhook ? 'webhook' : 'polling',
      wallet: {
        availableMilli: wallet.available_milli,
        heldMilli: wallet.held_milli,
        spentMilli: wallet.initial_milli - wallet.available_milli - wallet.held_milli,
        initialMilli: wallet.initial_milli,
      },
      model: {
        id: model.id,
        name: model.name,
        rateMilli: model.rate_milli,
        durations: Array.from({ length: 27 }, (_, i) => i + 4),
        resolutions: ['480p', '720p', '1080p'],
        rates: {
          '480p': model.rate_milli,
          '720p': model.rate_720_milli,
          '1080p': model.rate_1080_milli,
        },
      },
      jobs: jobs.map((j) => ({
        id: j.id,
        prompt: j.prompt,
        duration: j.requested_duration,
        resolution: j.resolution,
        modelId: j.model_id,
        mode: j.mode,
        taskType: j.provider_input?.taskType || 'generate',
        size: j.provider_input?.size || '16:9',
        outputFormat: j.provider_input?.outputFormat || 'mp4',
        inputSeconds: Number(j.input_duration_us) / 1e6,
        status: j.status,
        financialStatus: j.financial_status,
        progress: j.progress,
        rateMilli: j.rate_milli,
        estimateMilli: j.estimate_milli,
        holdMilli: j.hold_milli,
        actualDurationSeconds:
          j.actual_duration_us === null ? null : Number(j.actual_duration_us) / 1_000_000,
        actualCostMilli: j.actual_cost_milli,
        chargedMilli: j.charged_milli,
        releasedMilli: j.released_milli,
        absorbedMilli: j.absorbed_milli,
        videoUrl: j.status === 'completed' ? `/media/${j.id}` : null,
        errorCode: j.error_code,
        errorMessage: j.error_message,
        providerCostUsd: j.provider_cost_usd,
        providerCreditsCost: j.provider_credits_cost,
        createdAt: j.created_at.toISOString(),
        completedAt: j.completed_at?.toISOString() ?? null,
        deadlineAt: j.deadline_at.toISOString(),
      })),
      ledger: ledger.map((l) => ({
        id: l.id,
        jobId: l.job_id,
        kind: l.kind,
        amountMilli: l.amount_milli,
        availableDeltaMilli: l.available_delta_milli,
        heldDeltaMilli: l.held_delta_milli,
        availableAfterMilli: l.available_after_milli,
        heldAfterMilli: l.held_after_milli,
        createdAt: l.created_at.toISOString(),
        note: l.note,
      })),
    };
  });
}
