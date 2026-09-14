import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ProviderInput } from '../../shared/contracts.js';
import type { Database } from '../db/connection.js';
import { ProviderError } from '../errors.js';
import { MockAssets } from './mock-assets.js';
import type { ProviderResult, ProviderStatus, VideoProvider } from './types.js';

/** A deterministic development adapter. Its remote-task simulation also survives restarts. */
export class MockProvider implements VideoProvider {
  readonly displayName = 'Demo';
  readonly assets = new MockAssets();
  constructor(
    private pool: Database,
    private fixtureDir: string,
    private latencyMs = 7000,
  ) {}
  async submit(input: ProviderInput, _idempotencyKey: string) {
    const taskId = `mock_${randomUUID()}`;
    await this.pool.query(
      "INSERT INTO mock_provider_tasks(id,duration,ready_at) VALUES($1,$2,now()+$3*interval '1 millisecond')",
      [taskId, input.duration === 5 ? 5 : 4, this.latencyMs],
    );
    return { taskId };
  }
  private async task(taskId: string) {
    const {
      rows: [task],
    } = await this.pool.query('SELECT * FROM mock_provider_tasks WHERE id=$1', [taskId]);
    if (!task) throw new ProviderError('mock_task_missing', 'Тестове завдання не знайдено.');
    return task;
  }
  async poll(taskId: string): Promise<ProviderStatus> {
    const task = await this.task(taskId);
    const done = Date.now() >= new Date(task.ready_at).getTime();
    const progress = done
      ? 100
      : Math.max(
          5,
          Math.min(
            95,
            Math.round(((Date.now() - new Date(task.created_at).getTime()) / this.latencyMs) * 100),
          ),
        );
    return { state: done ? 'completed' : 'processing', progress, costUsd: null, creditsCost: null };
  }
  async result(taskId: string): Promise<ProviderResult> {
    const task = await this.task(taskId);
    if (Date.now() < new Date(task.ready_at).getTime())
      throw new ProviderError('result_not_ready', 'Тестовий результат ще не готовий.', true);
    return {
      source: { kind: 'file', path: join(this.fixtureDir, `demo-${task.duration}.mp4`) },
      costUsd: null,
      creditsCost: null,
    };
  }
}
