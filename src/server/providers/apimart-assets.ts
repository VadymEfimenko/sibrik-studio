import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AssetKind } from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import type { AssetInput, AssetPreparation, AssetProvider, AssetStatus } from './types.js';

export class ApiMartAssets implements AssetProvider {
  readonly requiresPublicMedia = true;
  readonly scope: string;
  constructor(
    private options: { apiKey: string; apiBase: string },
    private fetcher: typeof fetch = fetch,
  ) {
    // Preserve the existing account cache; other adapters own separate namespaces.
    this.scope = createHash('sha256').update(options.apiKey).digest('hex');
  }
  async prepare(input: AssetInput): Promise<AssetPreparation> {
    const url =
      input.kind === 'image'
        ? await this.uploadImage(input.path, input.mime)
        : (await input.publish()) || input.sourceUrl;
    if (!url)
      return {
        status: 'local',
        message:
          'Для локального відео/аудіо налаштуйте MEDIA_BASE_URL або імпортуйте файл за публічним HTTPS-посиланням.',
      };
    return { status: 'processing', taskId: await this.submit(url, input.kind, input.name) };
  }
  private async request(path: string, body?: BodyInit, json = false) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.apiBase}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
      });
    } catch {
      throw new AppError(
        502,
        'asset_connection',
        'Не вдалося підготувати файл у APIMart. Спробуйте повторити підготовку.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AppError(
        502,
        'asset_provider',
        `APIMart не прийняв референс (HTTP ${response.status}). Перевірте файл або повторіть пізніше.`,
      );
    }
    const data = await response.json();
    if (!data || data.error || (data.code !== undefined && data.code !== 200))
      throw new AppError(502, 'asset_response', 'Неочікувана відповідь бібліотеки APIMart.');
    return data;
  }
  async uploadImage(path: string, mime: string) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([await readFile(path)], { type: mime }),
      'reference.' + (mime.split('/')[1] || 'png'),
    );
    const result = await this.request('/v1/uploads/images', form);
    if (typeof result.url !== 'string' || !result.url.startsWith('https://'))
      throw new AppError(502, 'asset_response', 'APIMart не повернув адресу зображення.');
    return result.url as string;
  }
  async submit(url: string, kind: AssetKind, name: string) {
    const result = await this.request(
      '/v1/seedance2/private-avatar/assets',
      JSON.stringify({
        model: 'seedance-2.5',
        group: { name: 'sibrik-studio' },
        asset_type: { image: 'Image', video: 'Video', audio: 'Audio' }[kind],
        assets: [{ url, name }],
      }),
      true,
    );
    const id = result.data?.id;
    if (typeof id !== 'string' || !id || id.length > 200)
      throw new AppError(502, 'asset_response', 'APIMart не повернув ID перевірки референсу.');
    return id;
  }
  async poll(id: string): Promise<AssetStatus> {
    const envelope = await this.request(`/v1/tasks/${encodeURIComponent(id)}`);
    const task = envelope.data;
    if (task?.id !== id)
      throw new AppError(502, 'asset_response', 'Невірний ID перевірки референсу.');
    const usable = task.result?.usable_assets || task.result?.assets || [];
    const asset = Array.isArray(usable)
      ? usable.find(
          (a: Record<string, unknown>) => a.status === 'Active' && typeof a.asset_url === 'string',
        )
      : undefined;
    const url =
      asset?.asset_url || (task.status === 'completed' ? task.result?.asset_url : undefined);
    if (typeof url === 'string' && /^asset:\/\/[a-zA-Z0-9_-]+$/.test(url))
      return { status: 'ready', url };
    if (task.status === 'failed' || task.status === 'cancelled') return { status: 'failed' };
    if (!['pending', 'processing', 'completed'].includes(task.status))
      throw new AppError(502, 'asset_response', 'Невідомий статус перевірки референсу.');
    return { status: 'processing' };
  }
}
