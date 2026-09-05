import { useState, type FormEvent } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';
import { friendlyMoveError } from '../lib/moveErrors';
import type { BatchRecord } from '../lib/types';
import { mistPreview } from '../lib/formatSui';

interface StakePanelProps {
  batch: BatchRecord;
  onChanged: () => void;
}

/**
 * Shows the manufacturer's staked collateral for a batch, lets them top it
 * up while the batch is still active, and lets them withdraw it once
 * eligible. `add_stake`/`withdraw_stake` on-chain enforce the real rules
 * (must be this batch's manufacturer, not currently held, before/after
 * expiry respectively) — this only mirrors those in the UI so buttons are
 * disabled with an explanation instead of inviting a doomed transaction.
 */
export function StakePanel({ batch, onChanged }: StakePanelProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const [topUpSui, setTopUpSui] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isManufacturer = Boolean(account && account.address === batch.manufacturer);

  // Nothing staked and not the manufacturer — nothing useful to show a
  // random visitor. The manufacturer still sees the panel (with an "Add
  // stake" option) even at zero, since this is where they'd post one for
  // the first time after registering without a stake.
  if (batch.stakeAmount === 0 && !isManufacturer) return null;

  const stakeSui = batch.stakeAmount / Number(MIST_PER_SUI);
  const isExpired = batch.expiryMs <= Date.now();
  const canWithdraw = isManufacturer && batch.stakeAmount > 0 && isExpired && !batch.isHeld;
  const canTopUp = isManufacturer && !isExpired && !batch.isHeld;

  function handleTopUp(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const amountNum = Number(topUpSui);
    if (!topUpSui.trim() || !Number.isFinite(amountNum) || amountNum <= 0) {
      setError('Enter a positive amount of SUI to add.');
      return;
    }
    const amountMist = BigInt(Math.round(amountNum * Number(MIST_PER_SUI)));

    const tx = new Transaction();
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
    tx.moveCall({
      target: target('add_stake'),
      arguments: [tx.object(batch.objectId), payment, tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Stake topped up.');
          setTopUpSui('');
          onChanged();
        },
        onError: (err) => toast.error(friendlyMoveError(err.message)),
      },
    );
  }

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
        onError: (err) => toast.error(friendlyMoveError(err.message)),
      },
    );
  }

  return (
    <div className="hold-banner" style={{ marginTop: 16 }}>
      <strong>Manufacturer stake: {stakeSui} SUI locked</strong>
      <p className="helper-text" style={{ marginTop: 4 }}>
        Posted as collateral, and toppable up any time before expiry. A Critical + Counterfeit hold
        slashes it in full to the regulator as a bounty; a Critical Quality Defect or Cold-Chain
        Breach hold slashes 50%; a Recall + Counterfeit hold slashes 25%. Otherwise it's reclaimable
        by the manufacturer once the batch expires.
      </p>
      {error && <p className="error-text">{error}</p>}
      {isManufacturer && (
        <>
          <form onSubmit={handleTopUp} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ maxWidth: 160, marginBottom: 0 }}>
              <label htmlFor="topUpSui">Add stake (SUI)</label>
              <input
                id="topUpSui"
                type="number"
                min="0"
                step="0.01"
                value={topUpSui}
                onChange={(e) => setTopUpSui(e.target.value)}
                placeholder="e.g. 5"
                disabled={!canTopUp || isPending}
              />
              {Number(topUpSui) > 0 && (
                <p className="helper-text" style={{ marginTop: 2 }}>{mistPreview(Number(topUpSui))}</p>
              )}
            </div>
            <button type="submit" className="btn btn-secondary" disabled={!canTopUp || isPending}>
              {isPending ? 'Adding…' : 'Add stake'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleWithdraw}
              disabled={!canWithdraw || isPending}
            >
              {isPending ? 'Withdrawing…' : 'Withdraw stake'}
            </button>
          </form>
          {!isExpired && (
            <p className="helper-text" style={{ marginTop: 4 }}>
              Withdrawal locked until this batch expires ({new Date(batch.expiryMs).toLocaleDateString()})
              — collateral stays at risk for the batch's whole shelf life, not just until you feel
              like withdrawing it.
            </p>
          )}
          {batch.isHeld && (
            <p className="helper-text" style={{ marginTop: 4 }}>
              This batch is currently on hold — release it first before adding to or withdrawing
              the stake.
            </p>
          )}
        </>
      )}
    </div>
  );
}
