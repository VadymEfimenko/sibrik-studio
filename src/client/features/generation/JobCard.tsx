import {
  ArrowDownLeft,
  Check,
  ChevronDown,
  Download,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Sparkles,
  X,
} from 'lucide-react';
import type { GenerationJob } from '../../../shared/contracts';
import { credits, date, number } from '../../lib/format';
import { isActiveJob, statusNames, taskNames } from './labels';

export function JobCard({
  job,
  onEdit,
  editBusy,
  editDisabled,
  editError,
}: {
  job: GenerationJob;
  onEdit: () => void;
  editBusy: boolean;
  editDisabled: boolean;
  editError: string | null;
}) {
  const isActive = isActiveJob(job);
  const failed = job.financialStatus === 'released';
  return (
    <article className={`job-card ${failed ? 'job-failed' : ''}`} id={`job-${job.id}`}>
      <div className="job-preview">
        {job.videoUrl ? (
          <video
            src={job.videoUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={`Відео: ${job.prompt}`}
          />
        ) : (
          <div className={`processing-preview ${failed ? 'failed-preview' : ''}`}>
            <div className="preview-grid" />
            {failed ? (
              <X size={28} />
            ) : (
              <div className="progress-orbit">
                <Sparkles size={25} />
              </div>
            )}
            <strong>{statusNames[job.status]}</strong>
            {isActive && (
              <span>
                {job.progress !== null && job.progress < 100
                  ? `${job.progress}%`
                  : 'Це може тривати кілька хвилин'}
              </span>
            )}
          </div>
        )}
        {job.mode === 'mock' && <span className="preview-badge">DEMO</span>}
      </div>
      <div className="job-body">
        <div className="job-meta">
          <span className={`status-badge ${failed ? 'failed' : isActive ? 'working' : 'complete'}`}>
            {isActive ? (
              <span className="pulse-dot" />
            ) : failed ? (
              <X size={11} />
            ) : (
              <Check size={11} />
            )}
            {statusNames[job.status]}
          </span>
          <span className="job-time">{date(job.createdAt)}</span>
        </div>
        <p className="job-prompt">{job.prompt}</p>
        <div className="job-spec">
          <span>Seedance 2.5</span>
          <span>{job.resolution}</span>
          <span>{job.duration === -1 ? 'Авто' : `${job.duration} с`}</span>
          <span>{taskNames[job.taskType || 'generate']}</span>
          <span>{job.size}</span>
        </div>
        {job.errorMessage && (
          <p className={`job-message ${failed ? 'error-text' : ''}`}>{job.errorMessage}</p>
        )}
        <div className="job-finance">
          {isActive ? (
            <span>
              <LockKeyhole size={12} />У резерві <b>{credits(job.holdMilli)} кр.</b>
            </span>
          ) : failed ? (
            <span className="returned">
              <ArrowDownLeft size={13} />
              Повернено <b>{credits(job.releasedMilli || 0)} кр.</b>
            </span>
          ) : (
            <>
              <span>
                Списано <b>{credits(job.chargedMilli || 0)} кр.</b>
              </span>
              {!!job.releasedMilli && (
                <span className="returned">+{credits(job.releasedMilli)} кр. повернення</span>
              )}
            </>
          )}
          {job.videoUrl && (
            <div className="job-actions">
              <button type="button" className="edit-video" onClick={onEdit} disabled={editDisabled}>
                {editBusy ? <LoaderCircle className="spin" size={14} /> : <Pencil size={14} />}
                {editBusy ? 'Готуємо…' : 'Редагувати'}
              </button>
              <a
                href={job.videoUrl}
                download={`sibrik-${job.id.slice(0, 8)}.${job.outputFormat || 'mp4'}`}
                className="download-link"
                aria-label="Завантажити відео"
              >
                <Download size={16} />
              </a>
            </div>
          )}
        </div>
        {editError && (
          <p className="job-message error-text" role="alert">
            {editError}
          </p>
        )}
        <details className="job-details">
          <summary>
            Деталі розрахунку
            <ChevronDown size={13} />
          </summary>
          <dl>
            <div>
              <dt>Ідентифікатор</dt>
              <dd>#{job.id.slice(0, 8)}</dd>
            </div>
            <div>
              <dt>Тариф на момент запуску</dt>
              <dd>{credits(job.rateMilli)} кр./с</dd>
            </div>
            <div>
              <dt>Резерв</dt>
              <dd>{credits(job.holdMilli)} кр.</dd>
            </div>
            {!!job.inputSeconds && (
              <div>
                <dt>Тривалість відео на вході</dt>
                <dd>{number.format(job.inputSeconds)} с</dd>
              </div>
            )}
            {job.actualDurationSeconds !== null && (
              <>
                <div>
                  <dt>Тривалість результату</dt>
                  <dd>{number.format(job.actualDurationSeconds)} с</dd>
                </div>
                <div>
                  <dt>Вартість за тривалістю</dt>
                  <dd>{credits(job.actualCostMilli || 0)} кр.</dd>
                </div>
              </>
            )}
            {!!job.absorbedMilli && (
              <div>
                <dt>Покрито студією</dt>
                <dd>{credits(job.absorbedMilli)} кр.</dd>
              </div>
            )}
            <div>
              <dt>Вартість APIMart</dt>
              <dd>
                {job.mode === 'mock'
                  ? 'Немає платного запиту'
                  : job.providerCostUsd === null
                    ? 'Не надано'
                    : `$${number.format(Number(job.providerCostUsd))}`}
              </dd>
            </div>
            {job.providerCreditsCost !== null && (
              <div>
                <dt>Кредити APIMart</dt>
                <dd>{number.format(Number(job.providerCreditsCost))}</dd>
              </div>
            )}
          </dl>
        </details>
      </div>
    </article>
  );
}
