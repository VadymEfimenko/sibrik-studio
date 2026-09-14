import type { Estimate, GenerateInput, ProviderInput } from '../../shared/contracts.js';
import type { Database, Transaction } from '../db/connection.js';
import type { AssetRow, ModelRow } from '../db/rows.js';
import { AppError } from '../errors.js';
import { inputSchema } from '../jobs/input.js';
import { costForMicros } from './money.js';

const FIXED_DURATION_BUFFER_SECONDS = 1;

export async function quoteInput(
  db: Database | Transaction,
  raw: GenerateInput,
  scope?: string,
): Promise<{ input: ProviderInput; quote: Estimate }> {
  const input = inputSchema.parse(raw);
  const {
    rows: [model],
  } = await db.query<ModelRow>('SELECT * FROM models WHERE id=$1', [input.modelId]);
  if (!model) throw new AppError(400, 'unknown_model', 'Ця модель недоступна.');
  const media: NonNullable<ProviderInput['media']> = [];
  for (const reference of input.references) {
    const {
      rows: [asset],
    } = await db.query<AssetRow>('SELECT * FROM assets WHERE id=$1', [reference.assetId]);
    if (!asset || (scope && asset.scope !== scope))
      throw new AppError(400, 'missing_asset', 'Референс не знайдено у поточному режимі.');
    if (asset.status !== 'ready' || !asset.provider_url)
      throw new AppError(400, 'asset_not_ready', 'Дочекайтеся підготовки всіх референсів.');
    if (reference.role !== 'reference' && asset.kind !== 'image')
      throw new AppError(400, 'invalid_frame', 'Перший та останній кадр мають бути зображеннями.');
    media.push({
      kind: asset.kind,
      role: reference.role,
      url: asset.provider_url,
      durationMicros: Number(asset.duration_us),
    });
  }
  const videos = media.filter((m) => m.kind === 'video');
  const audios = media.filter((m) => m.kind === 'audio');
  const images = media.filter((m) => m.kind === 'image');
  const inputMicros = videos.reduce((sum, v) => sum + v.durationMicros, 0);
  if (
    images.length > 30 ||
    videos.length > 10 ||
    audios.length > 10 ||
    inputMicros > 30_000_000 ||
    audios.reduce((sum, a) => sum + a.durationMicros, 0) > 30_000_000
  )
    throw new AppError(
      400,
      'reference_limits',
      'Максимум 30 зображень, 10 відео (сумарно 30 с), 10 аудіо (сумарно 30 с).',
    );
  if (['edit', 'extend'].includes(input.taskType) && !videos.length)
    throw new AppError(400, 'source_required', 'Додайте вихідне відео.');
  if (input.taskType === 'edit' && videos[0].durationMicros < 4_000_000)
    throw new AppError(
      400,
      'edit_source_duration',
      'Для edit вихідне відео має тривати 4–30 секунд.',
    );
  const expectedOutputSeconds =
    input.taskType === 'edit'
      ? videos[0].durationMicros / 1e6
      : input.duration === -1
        ? 30
        : input.duration;
  // Only the internal hold includes the buffer; the provider still receives the requested duration.
  const reservedOutputSeconds =
    input.duration === -1 ? 30 : input.duration + FIXED_DURATION_BUFFER_SECONDS;
  const rateMilli =
    input.resolution === '480p'
      ? model.rate_milli
      : input.resolution === '720p'
        ? model.rate_720_milli
        : model.rate_1080_milli;
  const holdMilli = costForMicros(inputMicros + reservedOutputSeconds * 1e6, rateMilli);
  if (holdMilli > 1_000_000_000)
    throw new AppError(400, 'price_limit', 'Вартість перевищує ліміт сервісу.');
  return {
    input: { ...input, media, expectedDurationSeconds: expectedOutputSeconds },
    quote: {
      estimatedMilli: costForMicros(
        inputMicros + Math.round(expectedOutputSeconds * 1e6),
        rateMilli,
      ),
      holdMilli,
      rateMilli,
      duration: input.duration,
      resolution: input.resolution,
      modelId: input.modelId,
      currency: 'credits',
      capAtHold: true,
      inputSeconds: inputMicros / 1e6,
      expectedOutputSeconds,
      reservedOutputSeconds,
      automaticDuration: input.duration === -1,
    },
  };
}
