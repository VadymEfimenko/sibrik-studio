import type { ProviderInput } from '../../shared/contracts.js';
import { ProviderError } from '../errors.js';
import { z } from 'zod';
import { ApiMartAssets } from './apimart-assets.js';
import type { ProviderResult, ProviderStatus, VideoProvider } from './types.js';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError(
      'invalid_provider_response',
      'Провайдер повернув неочікувану відповідь.',
      true,
    );
  return value as JsonObject;
}
function providerMoney(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!/^\d+(\.\d{1,10})?$/.test(text) || text.length > 24) return null;
  return text;
}

export class ApiMartProvider implements VideoProvider {
  readonly displayName = 'APIMart';
  readonly assets: ApiMartAssets;
  readonly pollIntervalMs: number | undefined;
  readonly webhook = {
    path: '/callback',
    taskId(body: unknown) {
      const envelope = z.record(z.string(), z.unknown()).parse(body);
      const task =
        envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
          ? (envelope.data as Record<string, unknown>)
          : envelope;
      return typeof task.id === 'string' && task.id.length > 0 && task.id.length <= 200
        ? task.id
        : null;
    },
  };
  constructor(
    private options: { apiKey: string; baseUrl: string; timeoutMs: number; webhookBase: string },
    private fetcher: typeof fetch = fetch,
  ) {
    this.assets = new ApiMartAssets({ apiKey: options.apiKey, apiBase: options.baseUrl }, fetcher);
    this.pollIntervalMs = options.webhookBase ? 60000 : undefined;
  }

  private async request(
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<JsonObject> {
    const submitting = body !== undefined;
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.baseUrl}${path}`, {
        method: submitting ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          ...(submitting && idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(submitting ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new ProviderError(
        'provider_connection',
        'Не вдалося отримати відповідь провайдера.',
        true,
        submitting,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : undefined;
      const messages: Record<number, string> = {
        400: 'Провайдер відхилив параметри генерації.',
        401: 'Ключ провайдера недійсний. Перевірте налаштування сервера.',
        402: 'На рахунку провайдера недостатньо коштів. Ваш резерв повернено.',
        403: 'Ключ провайдера не має доступу до цієї операції.',
        429: 'Провайдер обмежив частоту запитів. Повторимо пізніше.',
      };
      throw new ProviderError(
        `provider_${response.status}`,
        messages[response.status] || 'Тимчасова помилка провайдера.',
        response.status === 429 || response.status >= 500,
        submitting && (response.status >= 500 || response.status === 408),
        Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs!, 300000) : undefined,
      );
    }
    try {
      const payload = object(await response.json());
      if (payload.error || (payload.code !== undefined && payload.code !== 200))
        throw new Error('Invalid response envelope');
      return payload;
    } catch {
      throw new ProviderError(
        'invalid_provider_response',
        'Провайдер повернув неочікувану відповідь.',
        true,
        submitting,
      );
    }
  }

  async submit(input: ProviderInput, idempotencyKey: string) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim())
      throw new ProviderError(
        'missing_idempotency_key',
        'Не вдалося визначити ключ запиту до провайдера.',
      );
    const payload = await this.request(
      '/v1/videos/generations',
      {
        model: input.modelId,
        prompt:
          input.taskType === 'edit'
            ? `Edit @视频1: ${input.prompt}`
            : input.taskType === 'extend'
              ? `Extend @视频1: ${input.prompt}`
              : input.prompt,
        duration: input.duration,
        resolution: input.resolution,
        size: input.size || '16:9',
        output_format: input.outputFormat || 'mp4',
        generate_audio: input.generateAudio ?? true,
        ...(input.watermark ? { watermark: true } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(['reference', 'edit', 'extend'].includes(input.taskType || '')
          ? { omni_reference_task_type: input.taskType }
          : {}),
        ...(input.media?.some((m) => m.kind === 'image')
          ? input.taskType === 'frames'
            ? {
                image_with_roles: input.media
                  .filter((m) => m.kind === 'image')
                  .map((m) => ({ url: m.url, role: m.role })),
              }
            : { image_urls: input.media.filter((m) => m.kind === 'image').map((m) => m.url) }
          : {}),
        ...(input.media?.some((m) => m.kind === 'video')
          ? { video_urls: input.media.filter((m) => m.kind === 'video').map((m) => m.url) }
          : {}),
        ...(input.media?.some((m) => m.kind === 'audio')
          ? { audio_urls: input.media.filter((m) => m.kind === 'audio').map((m) => m.url) }
          : {}),
        ...(this.options.webhookBase ? { webhook: this.options.webhookBase } : {}),
      },
      idempotencyKey,
    );
    const data = Array.isArray(payload.data) ? payload.data[0] : undefined;
    const taskId = data && typeof data === 'object' ? (data as JsonObject).task_id : undefined;
    if (typeof taskId !== 'string' || !taskId || taskId.length > 200) {
      throw new ProviderError(
        'invalid_submit_response',
        'Провайдер не повернув ідентифікатор завдання.',
        false,
        true,
      );
    }
    return { taskId };
  }

  private async task(taskId: string) {
    const payload = await this.request(`/v1/tasks/${encodeURIComponent(taskId)}?language=en`);
    const task = object(payload.data);
    if (task.id !== taskId)
      throw new ProviderError(
        'invalid_task_id',
        'Ідентифікатор у відповіді провайдера не відповідає завданню.',
        true,
      );
    return task;
  }

  async poll(taskId: string): Promise<ProviderStatus> {
    const task = await this.task(taskId);
    const known = ['pending', 'processing', 'completed', 'failed', 'cancelled'];
    if (typeof task.status !== 'string' || !known.includes(task.status)) {
      throw new ProviderError('invalid_provider_status', 'Невідомий статус провайдера.', true);
    }
    const progress =
      typeof task.progress === 'number' && Number.isFinite(task.progress)
        ? Math.max(0, Math.min(100, Math.round(task.progress)))
        : null;
    return {
      state: task.status === 'cancelled' ? 'failed' : (task.status as ProviderStatus['state']),
      progress,
      costUsd: providerMoney(task.cost),
      creditsCost: providerMoney(task.credits_cost),
      ...(task.status === 'failed' || task.status === 'cancelled'
        ? {
            errorCode: task.status === 'cancelled' ? 'provider_cancelled' : 'provider_failed',
            // Provider messages may echo prompts, URLs or internal details. Keep UI copy controlled.
            errorMessage:
              task.status === 'cancelled'
                ? 'Провайдер скасував генерацію.'
                : 'Провайдер не зміг завершити генерацію. Спробуйте інший промпт.',
          }
        : {}),
    };
  }

  async result(taskId: string): Promise<ProviderResult> {
    const task = await this.task(taskId);
    if (task.status !== 'completed')
      throw new ProviderError('result_not_ready', 'Результат ще не готовий.', true);
    const videos = object(task.result).videos;
    const urls = Array.isArray(videos) && videos.length ? object(videos[0]).url : undefined;
    if (!Array.isArray(urls) || typeof urls[0] !== 'string')
      throw new ProviderError(
        'missing_video',
        'Провайдер поки не повернув посилання на відео.',
        true,
      );
    return {
      source: { kind: 'url', url: urls[0] },
      costUsd: providerMoney(task.cost),
      creditsCost: providerMoney(task.credits_cost),
    };
  }
}
