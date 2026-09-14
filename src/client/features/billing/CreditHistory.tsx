import { ArrowDownLeft, ArrowUpRight, LockKeyhole, Wallet } from 'lucide-react';
import type { LedgerEntry } from '../../../shared/contracts';
import { credits, date } from '../../lib/format';
export function CreditHistory({
  entries,
  onSelectJob,
}: {
  entries: LedgerEntry[];
  onSelectJob: () => void;
}) {
  return (
    <section className="ledger-section" id="history">
      <div className="ledger-heading">
        <div>
          <h2>Історія кредитів</h2>
          <p>Кожен резерв, списання та повернення — окрема операція.</p>
        </div>
        <span className="ledger-count">{entries.length || 0} операцій</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Операція</th>
              <th>Генерація</th>
              <th className="numeric">Сума, кр.</th>
              <th className="numeric">Доступно після</th>
              <th className="numeric">Резерв після</th>
              <th className="numeric">Час</th>
            </tr>
          </thead>
          <tbody>
            {entries.length ? (
              entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <span className={`ledger-kind ${entry.kind}`}>
                      {entry.kind === 'hold' ? (
                        <LockKeyhole size={13} />
                      ) : entry.kind === 'settle' ? (
                        <ArrowUpRight size={14} />
                      ) : (
                        <ArrowDownLeft size={14} />
                      )}
                      {entry.kind === 'hold'
                        ? 'Резерв'
                        : entry.kind === 'settle'
                          ? 'Списання'
                          : 'Повернення'}
                    </span>
                  </td>
                  <td>
                    <a className="job-reference" href={`#job-${entry.jobId}`} onClick={onSelectJob}>
                      #{entry.jobId.slice(0, 8)}
                    </a>
                  </td>
                  <td className={`numeric amount ${entry.kind}`}>
                    {entry.kind === 'release' ? '+' : entry.kind === 'settle' ? '−' : ''}
                    {credits(entry.amountMilli)}
                  </td>
                  <td className="numeric">{credits(entry.availableAfterMilli)}</td>
                  <td className="numeric muted">{credits(entry.heldAfterMilli)}</td>
                  <td className="numeric muted date-cell">{date(entry.createdAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="ledger-empty">
                  <Wallet size={18} />
                  Операції з’являться після першої генерації.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="ledger-footnote">
        Резерв тимчасово зменшує доступний баланс. Це ще не списання.
        {(entries.length || 0) >= 150 && ' Показано останні 150 операцій.'}
      </div>
    </section>
  );
}
