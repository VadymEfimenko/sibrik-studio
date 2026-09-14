import { z } from 'zod';
import { aspectRatios, resolutions } from '../../shared/contracts.js';

export const inputSchema = z
  .object({
    modelId: z.literal('seedance-2.5'),
    prompt: z.string().trim().min(3, 'Опишіть сцену або зміну хоча б трьома символами.').max(2000),
    duration: z.union([z.literal(-1), z.number().int().min(4).max(30)]),
    resolution: z.enum(resolutions),
    taskType: z.enum(['generate', 'reference', 'frames', 'edit', 'extend']).default('generate'),
    size: z.enum(aspectRatios).default('16:9'),
    outputFormat: z.enum(['mp4', 'mov']).default('mp4'),
    generateAudio: z.boolean().default(true),
    watermark: z.boolean().default(false),
    seed: z.number().int().min(0).max(2147483647).optional(),
    references: z
      .array(
        z
          .object({
            assetId: z.string().uuid(),
            role: z.enum(['reference', 'first_frame', 'last_frame']),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(input.references.map((r) => r.assetId)).size !== input.references.length)
      error('Один файл можна додати лише один раз.');
    if (input.taskType === 'generate' && input.references.length)
      error('Для файлів виберіть режим референсів.');
    if (input.taskType !== 'generate' && !input.references.length)
      error('Додайте референс для цього режиму.');
    if (['edit', 'extend', 'frames'].includes(input.taskType) && input.size !== 'adaptive')
      error('Цей режим використовує пропорції вихідного файлу (adaptive).');
    if (input.taskType === 'edit' && input.duration !== -1)
      error('Edit зберігає тривалість джерела. Виберіть автоматичну тривалість.');
    if (input.taskType !== 'frames' && input.references.some((r) => r.role !== 'reference'))
      error('Перший та останній кадр доступні лише у режимі «Кадри».');
    if (
      input.taskType === 'frames' &&
      (input.references.length > 2 ||
        input.references.filter((r) => r.role === 'first_frame').length !== 1 ||
        input.references.filter((r) => r.role === 'last_frame').length > 1 ||
        input.references.some((r) => r.role === 'reference'))
    )
      error('Додайте один перший кадр і, за бажанням, один останній.');
  });
