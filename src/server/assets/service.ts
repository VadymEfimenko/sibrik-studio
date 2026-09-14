import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AssetKind, StudioAsset } from '../../shared/contracts.js';
import type { Config } from '../config.js';
import type { Database } from '../db/connection.js';
import type { AssetRow } from '../db/rows.js';
import { AppError } from '../errors.js';
import { inspectAsset } from '../media/inspect-asset.js';
import { download } from '../media/storage.js';
import type { AssetProvider } from '../providers/types.js';

const limits = { image: 20 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 15 * 1024 * 1024 };

export class Assets {
  private pending = new Set<Promise<void>>();
  readonly scope: string;
  constructor(
    private pool: Database,
    private config: Config,
    private provider: AssetProvider | undefined,
  ) {
    this.scope = provider?.scope ?? `${config.mode}:no-assets`;
  }
  async fromJob(jobId: string): Promise<StudioAsset> {
    const {
      rows: [job],
    } = await this.pool.query(
      "SELECT result_file FROM jobs WHERE id=$1 AND user_id=1 AND status='completed' AND financial_status='settled'",
      [jobId],
    );
    if (!job?.result_file || basename(job.result_file) !== job.result_file)
      throw new AppError(404, 'video_missing', 'Готове відео не знайдено.');
    const path = join(this.config.storageDir, job.result_file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile())
      throw new AppError(404, 'video_missing', 'Збережений файл відео недоступний.');
    // Reuse stored bytes through the same validation and hash cache as file uploads.
    return this.ingest(createReadStream(path), 'video', `Відео #${jobId.slice(0, 8)}`, 4_000_000);
  }
  async ingest(
    source: Readable | string,
    kind: AssetKind,
    name: string,
    minimumDurationMicros = 0,
  ): Promise<StudioAsset> {
    if (!this.provider)
      throw new AppError(422, 'references_unsupported', 'Цей провайдер не підтримує референси.');
    const directory = join(this.config.storageDir, 'references');
    await mkdir(directory, { recursive: true });
    const id = randomUUID();
    const temporary = join(directory, `${id}.part`);
    let final: string | undefined;
    try {
      if (typeof source === 'string') {
        try {
          await download(source, temporary, limits[kind]);
        } catch {
          throw new AppError(
            400,
            'reference_download',
            'Не вдалося завантажити референс. Потрібне пряме публічне HTTPS-посилання на файл.',
          );
        }
      } else {
        let bytes = 0;
        await pipeline(
          source,
          new Transform({
            transform(chunk: Buffer, _enc, done) {
              bytes += chunk.length;
              done(
                bytes > limits[kind]
                  ? new AppError(413, 'file_size', 'Файл перевищує дозволений розмір.')
                  : null,
                chunk,
              );
            },
          }),
          createWriteStream(temporary, { flags: 'wx' }),
        );
      }
      const info = await stat(temporary);
      if (!info.size || info.size > limits[kind])
        throw new AppError(400, 'file_size', 'Порожній або завеликий файл.');
      const meta = await inspectAsset(temporary, kind, this.config.ffprobePath);
      if (meta.durationMicros < minimumDurationMicros)
        throw new AppError(
          400,
          'edit_duration',
          'Для редагування потрібне відео від 4 до 30 секунд.',
        );
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(temporary)) hash.update(chunk);
      const digest = hash.digest('hex');
      const fileName = `${id}.${meta.extension}`;
      final = join(directory, fileName);
      await rename(temporary, final);
      const localUrl = this.provider.localUrl?.(id);
      const result = await this.pool.query(
        `INSERT INTO assets(id,scope,hash,name,kind,file_name,mime,bytes,width,height,duration_us,source_url,status,public_token,provider_url)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(scope,hash) DO NOTHING RETURNING id`,
        [
          id,
          this.scope,
          digest,
          name.slice(0, 180) || 'Референс',
          kind,
          fileName,
          meta.mime,
          info.size,
          meta.width,
          meta.height,
          meta.durationMicros,
          typeof source === 'string' ? source : null,
          localUrl ? 'ready' : 'local',
          randomBytes(32).toString('hex'),
          localUrl ?? null,
        ],
      );
      if (!result.rowCount) {
        await unlink(final);
        final = undefined;
        const {
          rows: [existing],
        } = await this.pool.query('SELECT id FROM assets WHERE scope=$1 AND hash=$2', [
          this.scope,
          digest,
        ]);
        return this.get(existing.id);
      }
      final = undefined;
      return this.get(id);
    } finally {
      await unlink(temporary).catch(() => {});
      if (final) await unlink(final).catch(() => {});
    }
  }
  async prepare(id: string) {
    const {
      rows: [asset],
    } = await this.pool.query<AssetRow>(
      `UPDATE assets SET lease_until=now()+interval '150 seconds' WHERE id=$1 AND scope=$2 AND status IN ('local','processing') AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
      [id, this.scope],
    );
    if (!asset) return;
    try {
      if (!this.provider)
        throw new AppError(422, 'references_unsupported', 'Цей провайдер не підтримує референси.');
      if (asset.provider_task_id) {
        if (
          asset.moderation_started_at &&
          Date.now() - new Date(asset.moderation_started_at).getTime() > 30 * 60 * 1000
        )
          throw new AppError(
            504,
            'asset_timeout',
            'Перевірка референсу триває понад 30 хвилин. Спробуйте інший файл.',
          );
        const result = await this.provider.poll(asset.provider_task_id);
        await this.pool.query(
          `UPDATE assets SET status=$2,provider_url=COALESCE($3,provider_url),error_message=$4,provider_task_id=CASE WHEN $2='failed' THEN NULL ELSE provider_task_id END,next_attempt_at=now()+interval '5 seconds' WHERE id=$1`,
          [
            id,
            result.status,
            result.status === 'ready' ? result.url : null,
            result.status === 'failed'
              ? 'Провайдер відхилив референс. Спробуйте інший файл.'
              : null,
          ],
        );
      } else {
        const result = await this.provider.prepare({
          id,
          path: join(this.config.storageDir, 'references', asset.file_name),
          mime: asset.mime,
          kind: asset.kind,
          name: asset.name,
          sourceUrl: asset.source_url,
          publish: async () => {
            if (!this.config.mediaBase) return null;
            await this.pool.query(
              "UPDATE assets SET public_until=now()+interval '24 hours' WHERE id=$1",
              [id],
            );
            return `${this.config.mediaBase}/reference/${id}/${asset.public_token}`;
          },
        });
        await this.pool.query(
          `UPDATE assets SET status=$2,provider_task_id=$3,provider_url=$4,error_message=$5,
          moderation_started_at=CASE WHEN $2='processing' THEN now() ELSE moderation_started_at END,
          next_attempt_at=now()+interval '5 seconds' WHERE id=$1`,
          [
            id,
            result.status,
            result.status === 'processing' ? result.taskId : null,
            result.status === 'ready' ? result.url : null,
            result.status === 'local' ? result.message : null,
          ],
        );
      }
    } catch (error) {
      await this.pool.query("UPDATE assets SET status='failed',error_message=$2 WHERE id=$1", [
        id,
        error instanceof AppError
          ? error.message
          : 'Не вдалося підготувати референс. Повторіть підготовку.',
      ]);
    } finally {
      await this.pool.query('UPDATE assets SET lease_until=NULL WHERE id=$1', [id]);
    }
  }
  async retry(id: string) {
    await this.pool.query(
      "UPDATE assets SET status=CASE WHEN provider_task_id IS NULL THEN 'local' ELSE 'processing' END,error_message=NULL,next_attempt_at=now() WHERE id=$1 AND scope=$2 AND status IN ('failed','local')",
      [id, this.scope],
    );
    await this.prepare(id);
    return this.get(id);
  }
  async get(id: string): Promise<StudioAsset> {
    const {
      rows: [asset],
    } = await this.pool.query<AssetRow>('SELECT * FROM assets WHERE id=$1 AND scope=$2', [
      id,
      this.scope,
    ]);
    if (!asset) throw new AppError(404, 'asset_missing', 'Файл не знайдено.');
    return this.serialize(asset);
  }
  private serialize(a: AssetRow): StudioAsset {
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      durationSeconds:
        a.duration_us === '0' || !Number(a.duration_us) ? null : Number(a.duration_us) / 1e6,
      width: a.width,
      height: a.height,
      bytes: a.bytes,
      status: a.status,
      error: a.error_message,
      previewUrl: `/api/assets/${a.id}/media`,
      createdAt: a.created_at.toISOString(),
    };
  }
  async list() {
    const { rows: pending } = await this.pool.query(
      "SELECT id FROM assets WHERE scope=$1 AND status IN ('local','processing') AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 4",
      [this.scope],
    );
    for (const asset of pending) {
      if (this.pending.size >= 4) break;
      const task = this.prepare(asset.id)
        .catch(() => {})
        .finally(() => this.pending.delete(task));
      this.pending.add(task);
    }
    const { rows } = await this.pool.query<AssetRow>(
      'SELECT * FROM assets WHERE scope=$1 ORDER BY created_at DESC LIMIT 100',
      [this.scope],
    );
    return {
      assets: rows.map((a) => this.serialize(a)),
      localMediaReady:
        !!this.provider && (!this.provider.requiresPublicMedia || !!this.config.mediaBase),
    };
  }
  async stop() {
    await Promise.allSettled(this.pending);
  }
}
