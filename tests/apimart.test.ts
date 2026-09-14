import { describe, expect, it, vi } from 'vitest';
import { ApiMartProvider } from '../src/server/providers/apimart.js';
import type { GenerateInput } from '../src/shared/contracts.js';
const input: GenerateInput = {
  modelId: 'seedance-2.5',
  prompt: 'Soft morning light',
  duration: 4,
  resolution: '480p',
};
const idempotencyKey = 'f51cb72c-7b22-4848-babb-fc51351b377e';
const options = {
  apiKey: 'test-key-not-real',
  baseUrl: 'https://api.apimart.ai',
  timeoutMs: 1000,
  webhookBase: 'https://callback.example',
};
function adapter(payload: unknown, status = 200, headers = {}) {
  const fetcher = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(payload), { status, headers }));
  return { provider: new ApiMartProvider(options, fetcher), fetcher };
}
describe('APIMart adapter against documented response fixtures', () => {
  it('submits exactly the supported model and webhook origin', async () => {
    const { provider, fetcher } = adapter({
      code: 200,
      data: [{ task_id: 'remote-123', status: 'submitted' }],
    });
    expect(await provider.submit(input, idempotencyKey)).toEqual({ taskId: 'remote-123' });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.apimart.ai/v1/videos/generations');
    expect(request.headers.Authorization).toBe('Bearer test-key-not-real');
    expect(request.headers['Idempotency-Key']).toBe(idempotencyKey);
    expect(JSON.parse(request.body)).toEqual({
      model: 'seedance-2.5',
      prompt: input.prompt,
      duration: 4,
      resolution: '480p',
      size: '16:9',
      output_format: 'mp4',
      generate_audio: true,
      webhook: 'https://callback.example',
    });
  });
  it('extracts the first URL from the documented URL array', async () => {
    const { provider, fetcher } = adapter({
      code: 200,
      data: {
        id: 'remote-123',
        status: 'completed',
        actual_time: 180,
        cost: 0.38432,
        credits_cost: 3.8432,
        result: { videos: [{ url: ['https://cdn.example/video.mp4'] }] },
      },
    });
    expect(await provider.result('remote-123')).toEqual({
      source: { kind: 'url', url: 'https://cdn.example/video.mp4' },
      costUsd: '0.38432',
      creditsCost: '3.8432',
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.apimart.ai/v1/tasks/remote-123?language=en');
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBeUndefined();
  });
  it('rejects a missing idempotency key before making a paid request', async () => {
    const { provider, fetcher } = adapter({});
    await expect(provider.submit(input, '')).rejects.toMatchObject({
      code: 'missing_idempotency_key',
      retryable: false,
      submissionUncertain: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 402, 403])('treats submit HTTP %s as a definite rejection', async (status) => {
    await expect(adapter({}, status).provider.submit(input, idempotencyKey)).rejects.toMatchObject({
      code: `provider_${status}`,
      retryable: false,
      submissionUncertain: false,
    });
  });
  it('honors Retry-After for 429 without marking submission ambiguous', async () => {
    await expect(
      adapter({}, 429, { 'Retry-After': '90' }).provider.submit(input, idempotencyKey),
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 90000, submissionUncertain: false });
  });
  it('treats submit 500 as ambiguous and GET 500 as retryable', async () => {
    const { provider } = adapter({}, 500);
    await expect(provider.submit(input, idempotencyKey)).rejects.toMatchObject({
      retryable: true,
      submissionUncertain: true,
    });
    await expect(provider.poll('id')).rejects.toMatchObject({
      retryable: true,
      submissionUncertain: false,
    });
  });
  it('does not retry submit blindly after network failure or malformed success', async () => {
    const provider = new ApiMartProvider(
      options,
      vi.fn().mockRejectedValue(new TypeError('network')),
    );
    await expect(provider.submit(input, idempotencyKey)).rejects.toMatchObject({
      submissionUncertain: true,
    });
    await expect(
      adapter({ code: 200, data: [] }).provider.submit(input, idempotencyKey),
    ).rejects.toMatchObject({
      submissionUncertain: true,
    });
  });
  it.each(['failed', 'cancelled'])('maps terminal %s to failure', async (status) => {
    expect(
      await adapter({ code: 200, data: { id: 'task', status } }).provider.poll('task'),
    ).toMatchObject({ state: 'failed', costUsd: null });
  });
  it('does not invent missing provider costs or accept an unrelated task', async () => {
    expect(
      await adapter({
        code: 200,
        data: { id: 'task', status: 'processing', progress: 55 },
      }).provider.poll('task'),
    ).toMatchObject({ state: 'processing', progress: 55, costUsd: null, creditsCost: null });
    await expect(
      adapter({ code: 200, data: { id: 'wrong', status: 'completed' } }).provider.poll('task'),
    ).rejects.toMatchObject({ code: 'invalid_task_id' });
  });
});
