import { Film, FlaskConical, LoaderCircle, Radio, Sparkles } from 'lucide-react';
import type { GenerationJob, StudioState } from '../../../shared/contracts';
import { WalletSummary } from '../billing/WalletSummary';
import { JobCard } from './JobCard';
import { isActiveJob } from './labels';
export type JobFilter = 'all' | 'active' | 'completed';
export function GenerationResults({
  state,
  filter,
  onFilterChange,
  editVideo,
  editingJobId,
  editDisabled,
  editError,
}: {
  state: StudioState | null;
  filter: JobFilter;
  onFilterChange: (filter: JobFilter) => void;
  editVideo: (job: GenerationJob) => Promise<void>;
  editingJobId: string | null;
  editDisabled: boolean;
  editError: { jobId: string; message: string } | null;
}) {
  const jobs =
    state?.jobs.filter(
      (job) =>
        filter === 'all' || (filter === 'active' ? isActiveJob(job) : job.status === 'completed'),
    ) || [];
  const busyCount = state?.jobs.filter(isActiveJob).length || 0;
  return (
    <section className="results" aria-label="Ваші генерації">
      <WalletSummary wallet={state?.wallet ?? null} />
      <div className="results-heading">
        <h2>
          Ваші генерації <span>{state?.jobs.length || 0}</span>
        </h2>
        <span className="auto-update">
          <Radio size={13} />
          Автооновлення
        </span>
      </div>
      <div className="tabs" aria-label="Фільтр генерацій">
        {(
          [
            { id: 'all', text: 'Усі' },
            { id: 'active', text: `У роботі${busyCount ? ` · ${busyCount}` : ''}` },
            { id: 'completed', text: 'Готові' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => onFilterChange(tab.id)}
            className={filter === tab.id ? 'current' : ''}
            aria-pressed={filter === tab.id}
          >
            {tab.text}
          </button>
        ))}
      </div>
      {!state ? (
        <div className="empty-state">
          <LoaderCircle className="spin" />
          <h3>Підключаємо студію</h3>
          <p>Завантажуємо баланс і ваші генерації.</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-art">
            <div className="frame-back" />
            <div className="frame-front">
              <Film size={38} strokeWidth={1} />
              <span />
              <span />
              <span />
            </div>
            <Sparkles className="empty-spark" size={20} />
          </div>
          <span className="empty-kicker">МІСЦЕ ДЛЯ ВАШОЇ ІДЕЇ</span>
          <h3>
            {filter === 'all'
              ? 'Усе починається зі сцени'
              : filter === 'active'
                ? 'Усе спокійно'
                : 'Готові відео будуть тут'}
          </h3>
          <p>
            {filter === 'all'
              ? 'Опишіть її ліворуч. Тут з’явиться відео, а поки воно створюється — його статус.'
              : filter === 'active'
                ? 'Зараз немає генерацій у роботі.'
                : 'Спочатку створіть свою першу генерацію.'}
          </p>
          {filter === 'all' && (
            <span className="empty-spec">
              SEEDANCE 2.5 <i />
              480–1080P <i />
              4–30 С
            </span>
          )}
        </div>
      ) : (
        <div className="job-list">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onEdit={() => void editVideo(job)}
              editBusy={editingJobId === job.id}
              editDisabled={editDisabled}
              editError={editError?.jobId === job.id ? editError.message : null}
            />
          ))}
        </div>
      )}
      {state?.mode === 'mock' && (
        <div className="demo-caption">
          <FlaskConical size={15} />
          <p>
            Демо без витрат: замість ШІ-генерації використовується тестове відео. Баланс і
            розрахунки працюють повністю.
          </p>
        </div>
      )}
    </section>
  );
}
