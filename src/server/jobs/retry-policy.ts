import type { WorkItem } from './job-repository.js';

export function retryDelay(
  job: Pick<WorkItem, 'mode' | 'processing_attempt'>,
  retryAfter?: number,
) {
  if (retryAfter) return retryAfter;
  if (job.mode === 'mock') return 1000;
  return (
    Math.min(30000, 5000 * 2 ** Math.min(job.processing_attempt, 3)) +
    Math.floor(Math.random() * 1000)
  );
}
