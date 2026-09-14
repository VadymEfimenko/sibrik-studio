import { Check, FlaskConical, Info, Video, Wallet, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CreditHistory } from './features/billing/CreditHistory';
import { GenerationComposer } from './features/generation/GenerationComposer';
import { GenerationResults, type JobFilter } from './features/generation/GenerationResults';
import { useGenerationForm } from './features/generation/useGenerationForm';
import { AboutDialog } from './features/studio/AboutDialog';
import { useStudioState } from './features/studio/useStudioState';
import { credits } from './lib/format';

export function App() {
  const { state, loadError, connected, refresh } = useStudioState();
  const [filter, setFilter] = useState<JobFilter>('all');
  const [notice, setNotice] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const form = useGenerationForm({
    state,
    refresh,
    onNotice: setNotice,
    onSubmitted: () => setFilter('all'),
  });
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Розділи">
        <a className="brand-icon" href="#studio" aria-label="Sibrik Studio">
          <Zap size={25} fill="currentColor" />
        </a>
        <a className="rail-link selected" href="#studio" aria-label="Генерація відео">
          <Video size={21} />
        </a>
        <a className="rail-link" href="#history" aria-label="Історія операцій">
          <Wallet size={21} />
        </a>
        <button className="rail-help" onClick={() => setShowInfo(true)} aria-label="Про студію">
          <Info size={20} />
        </button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <a className="wordmark" href="#studio">
            SIBRIK<span>.STUDIO</span>
          </a>
          <div className="topbar-right">
            <span className={`connection ${connected ? 'online' : ''}`} title="Оновлення стану">
              <span />
              {connected ? 'На зв’язку' : 'Повторне підключення'}
            </span>
            <div className="balance-pill">
              <Zap size={15} fill="currentColor" />
              <span>{state ? credits(state.wallet.availableMilli) : '—'}</span>
              <small>кредитів</small>
            </div>
            <span className="avatar" title="Тестовий користувач">
              S
            </span>
          </div>
        </header>
        <main id="studio">
          <div className="page-heading">
            <div>
              <div className="eyebrow">GENERATIVE WORKSPACE</div>
              <h1>
                Video Studio<span>.</span>
              </h1>
              <p>Ваша ідея. Кілька секунд кіно.</p>
            </div>
            <button
              className={`mode-pill ${state && state.mode !== 'mock' ? 'real' : ''}`}
              onClick={() => setShowInfo(true)}
            >
              <FlaskConical size={15} />
              {state && state.mode !== 'mock' ? `${state.providerName} підключено` : 'Демо-режим'}
              <Info size={13} />
            </button>
          </div>
          {loadError && (
            <div className="banner error" role="alert">
              {loadError}
              <button
                onClick={() => {
                  void refresh();
                }}
              >
                Оновити
              </button>
            </div>
          )}
          <div className="studio-grid">
            <GenerationComposer form={form} state={state} loadError={loadError} />
            <GenerationResults
              state={state}
              filter={filter}
              onFilterChange={setFilter}
              editVideo={form.editVideo}
              editingJobId={form.editingJobId}
              editDisabled={
                form.sending || form.unconfirmed || form.assetsBusy || !!form.editingJobId
              }
              editError={form.editError}
            />
          </div>
          <CreditHistory entries={state?.ledger ?? []} onSelectJob={() => setFilter('all')} />
          <footer className="footer">
            <span>
              SIBRIK<span className="muted">.STUDIO</span>
            </span>
            <span>Зробіть ідею видимою.</span>
            <span>
              Seedance 2.5 <span className="footer-dot">●</span>
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
          <button onClick={() => setNotice('')} aria-label="Закрити сповіщення">
            <X size={15} />
          </button>
        </div>
      )}
      <AboutDialog
        open={showInfo}
        onClose={() => setShowInfo(false)}
        mode={state?.mode}
        providerName={state?.providerName}
      />
    </div>
  );
}
