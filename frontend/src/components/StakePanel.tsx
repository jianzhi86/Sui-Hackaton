import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';
import type { BatchRecord } from '../lib/types';

interface StakePanelProps {
  batch: BatchRecord;
  onChanged: () => void;
}

/**
 * Shows the manufacturer's staked collateral for a batch, and lets them
 * withdraw it once eligible. `withdraw_stake` on-chain enforces the real
 * rules (must be this batch's manufacturer, not currently held, past
 * expiry) — this only mirrors those in the UI so the button is disabled
 * with an explanation instead of inviting a doomed transaction.
 */
export function StakePanel({ batch, onChanged }: StakePanelProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();

  if (batch.stakeAmount === 0) return null;

  const stakeSui = batch.stakeAmount / Number(MIST_PER_SUI);
  const isManufacturer = Boolean(account && account.address === batch.manufacturer);
  const isExpired = batch.expiryMs <= Date.now();
  const canWithdraw = isManufacturer && isExpired && !batch.isHeld;

  function handleWithdraw() {
    const tx = new Transaction();
    tx.moveCall({
      target: target('withdraw_stake'),
      arguments: [tx.object(batch.objectId), tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Stake withdrawn back to the manufacturer.');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <div className="hold-banner" style={{ marginTop: 16 }}>
      <strong>Manufacturer stake: {stakeSui} SUI locked</strong>
      <p className="helper-text" style={{ marginTop: 4 }}>
        Posted at registration as collateral. If a regulator places a Critical + Counterfeit hold
        on this batch, this is paid out to them as a bounty. Otherwise it's reclaimable by the
        manufacturer once the batch expires.
      </p>
      {isManufacturer && (
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleWithdraw}
            disabled={!canWithdraw || isPending}
          >
            {isPending ? 'Withdrawing…' : 'Withdraw stake'}
          </button>
          {!isExpired && (
            <p className="helper-text" style={{ marginTop: 4 }}>
              Locked until this batch expires ({new Date(batch.expiryMs).toLocaleDateString()}) —
              collateral stays at risk for the batch's whole shelf life, not just until you feel
              like withdrawing it.
            </p>
          )}
          {isExpired && batch.isHeld && (
            <p className="helper-text" style={{ marginTop: 4 }}>
              This batch is currently on hold — release it first before withdrawing.
            </p>
          )}
        </>
      )}
    </div>
  );
}
