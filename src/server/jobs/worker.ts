import type { ProviderInput } from '../../shared/contracts.js';
import { release, settle } from '../billing/credits.js';
import type { Config } from '../config.js';
import type { Database } from '../db/connection.js';
import { ProviderError } from '../errors.js';
import { removeUncommittedVideo, storeVideo } from '../media/storage.js';
import type { ProviderRegistry, ProviderStatus, VideoProvider } from '../providers/types.js';
import { JobRepository, type WorkItem } from './job-repository.js';
import { retryDelay } from './retry-policy.js';

export class Worker {
  private stopping = false;
  private running = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private jobs: JobRepository;
  constructor(
    private pool: Database,
    private config: Config,
    private providers: ProviderRegistry,
  ) {
    this.jobs = new JobRepository(pool);
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
    void this.tick();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    while (this.ticking) await new Promise((r) => setTimeout(r, 20));
    await Promise.allSettled(this.running);
  }
  private async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      while (!this.stopping && this.running.size < this.config.concurrency) {
        const job = await this.jobs.claim();
        if (!job) break;
        const pending = this.process(job)
          .catch((error) => {
            // Never log request bodies, provider URLs or credentials.
            console.error('Worker iteration failed', {
              jobId: job.id,
              type: error?.name || 'Error',
            });
          })
          .finally(() => {
            this.running.delete(pending);
          });
        this.running.add(pending);
      }
    } catch {
      console.error('Worker could not reach the database; will retry.');
    } finally {
      this.ticking = false;
    }
  }
  /** One iteration, exported for integration tests and maintenance commands. */
  async runOnce(): Promise<boolean> {
    const job = await this.jobs.claim();
    if (!job) return false;
    await this.process(job);
    return true;
  }
  private async process(job: WorkItem) {
    const heartbeat = setInterval(() => {
      void this.jobs.renewLease(job).catch(() => {});
    }, 20000);
    try {
      if (job.deadline_at.getTime() <= Date.now()) {
        await release(
          this.pool,
          job.id,
          'job_timeout',
          'Час очікування минув. Резерв повернено.',
          'timed_out',
          job.lease_token,
        );
        return;
      }
      const provider = Object.hasOwn(this.providers, job.mode)
        ? this.providers[job.mode]
        : undefined;
      if (!provider) {
        await this.jobs.waitForConfiguration(job);
        return;
      }
      if (!job.provider_task_id) await this.submit(job, provider);
      else await this.poll(job, provider, job.provider_task_id);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async submit(job: WorkItem, provider: VideoProvider) {
    if (job.status !== 'queued') {
      await this.jobs.markSubmissionUnknown(
        job,
        'Відповідь на запуск не підтверджено. Повторне платне надсилання зупинено; резерв буде повернено після завершення часу очікування.',
      );
      return;
    }
    if (!(await this.jobs.markSubmitting(job))) return;
    const input: ProviderInput = job.provider_input || {
      modelId: job.model_id,
      prompt: job.prompt,
      duration: job.requested_duration,
      resolution: job.resolution,
    };
    try {
      // Use the persisted job ID; the lease token changes on every claim.
      const { taskId } = await provider.submit(input, job.id);
      await this.jobs.markSubmitted(job, taskId);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.submissionUncertain) {
        await this.jobs.markSubmissionUnknown(
          job,
          'Не отримали підтвердження запуску. Зберігаємо резерв до завершення часу очікування, щоб уникнути повторної оплати.',
        );
      } else if (error.retryable) {
        await this.jobs.retrySubmission(job, retryDelay(job, error.retryAfterMs), error);
      } else await release(this.pool, job.id, error.code, error.message, 'failed', job.lease_token);
    }
  }

  private async poll(job: WorkItem, provider: VideoProvider, taskId: string) {
    try {
      const state = await provider.poll(taskId);
      if (state.state === 'failed') {
        // Preserve provider expenditure even when releasing the user's credits.
        if (!(await this.jobs.recordProviderFailure(job, state))) return;
        await release(
          this.pool,
          job.id,
          state.errorCode || 'provider_failed',
          state.errorMessage || 'Генерацію не завершено.',
          'failed',
          job.lease_token,
        );
        return;
      }
      if (state.state !== 'completed') {
        await this.jobs.recordProgress(
          job,
          { ...state, state: state.state },
          provider.pollIntervalMs ?? retryDelay(job),
        );
        return;
      }
      await this.saveResult(job, provider, taskId, state);
    } catch (error) {
      if (error instanceof ProviderError && !error.retryable)
        await release(this.pool, job.id, error.code, error.message, 'failed', job.lease_token);
      else
        await this.jobs.retryPoll(
          job,
          retryDelay(job, error instanceof ProviderError ? error.retryAfterMs : undefined),
        );
    }
  }

  private async saveResult(
    job: WorkItem,
    provider: VideoProvider,
    taskId: string,
    state: ProviderStatus,
  ) {
    if (!(await this.jobs.beginDownload(job, state))) return;
    let stored;
    try {
      const result = await provider.result(taskId);
      stored = await storeVideo(
        result,
        this.config.storageDir,
        job.id,
        job.lease_token,
        this.config.ffprobePath,
        job.provider_input?.outputFormat,
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.retryable)
          await this.jobs.retryDownload(job, retryDelay(job, error.retryAfterMs), error);
        else await release(this.pool, job.id, error.code, error.message, 'failed', job.lease_token);
      } else if (job.download_attempt < 2) {
        await this.jobs.retryDownload(
          job,
          retryDelay(job),
          {
            code: 'download_retry',
            message: 'Перевіряємо та зберігаємо результат. Повторюємо отримання файлу.',
          },
          job.download_attempt + 1,
        );
      } else
        await release(
          this.pool,
          job.id,
          'invalid_video',
          'Не вдалося отримати та перевірити відео. Резерв повернено.',
          'failed',
          job.lease_token,
        );
      return;
    }
    // An ambiguous COMMIT may already reference the file; retain it on database errors.
    // Database failures do not consume the media validation retry budget.
    const committed = await settle(this.pool, job.id, stored, job.lease_token);
    if (!committed) await removeUncommittedVideo(this.config.storageDir, stored.resultFile);
  }
}
