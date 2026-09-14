import type { GenerationJob, JobStatus, TaskType } from '../../../shared/contracts';
export const statusNames: Record<JobStatus, string> = {
  queued: 'У черзі',
  submitting: 'Запускаємо',
  submission_unknown: 'Уточнюємо запуск',
  pending: 'Очікуємо на провайдера',
  processing: 'Генерується',
  downloading: 'Зберігаємо відео',
  completed: 'Готово',
  failed: 'Не вдалося',
  timed_out: 'Час очікування минув',
};
export const isActiveJob = (job: GenerationJob) => job.financialStatus === 'held';
export const taskNames: Record<TaskType, string> = {
  generate: 'З тексту',
  reference: 'Референси',
  frames: 'Кадри',
  edit: 'Редагування',
  extend: 'Продовження',
};
