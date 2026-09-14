import { LockKeyhole } from 'lucide-react';
import type { Wallet } from '../../../shared/contracts';
import { credits } from '../../lib/format';
export function WalletSummary({ wallet }: { wallet: Wallet | null }) {
  return (
    <div className="wallet-summary">
      <div>
        <span>Доступно</span>
        <strong>
          {wallet ? credits(wallet.availableMilli) : '—'}
          <small>кр.</small>
        </strong>
      </div>
      <div>
        <span>
          У резерві
          <LockKeyhole size={11} />
        </span>
        <strong>
          {wallet ? credits(wallet.heldMilli) : '—'}
          <small>кр.</small>
        </strong>
      </div>
      <div>
        <span>Витрачено</span>
        <strong>
          {wallet ? credits(wallet.spentMilli) : '—'}
          <small>кр.</small>
        </strong>
      </div>
    </div>
  );
}
