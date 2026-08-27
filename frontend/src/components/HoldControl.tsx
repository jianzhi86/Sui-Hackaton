import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, PACKAGE_ID, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import type { BatchRecord } from '../lib/types';

interface HoldControlProps {
  batch: BatchRecord;
  onChanged: () => void;
}

/**
 * Placing/releasing a hold requires a `RegulatorCap` object (unlike
 * checkpoints, which anyone can add). This looks up whether the connected
 * wallet owns one and, if so, passes its object ID into the moveCall —
 * the Move side re-checks this by type, so the frontend check is purely
 * for UX (hiding the form), not the actual security boundary.
 */
function useRegulatorCap() {
  const account = useCurrentAccount();
  const { data, isLoading, refetch } = useSuiClientQuery(
    'getOwnedObjects',
    {
      owner: account?.address ?? '',
      filter: { StructType: `${PACKAGE_ID}::batch::RegulatorCap` },
      options: { showContent: false },
    },
    { enabled: Boolean(account) },
  );

  const capId = data?.data?.[0]?.data?.objectId ?? null;
  return { capId, isLoading, refetch };
}

/**
 * Lets a `RegulatorCap` holder place or release a hold on a batch.
 * `place_hold` freezes the on-chain custody chain: `add_checkpoint` aborts
 * while `is_held` is true, so this isn't just a cosmetic flag.
 */
export function HoldControl({ batch, onChanged }: HoldControlProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const { capId, isLoading: capLoading, refetch: refetchCap } = useRegulatorCap();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handlePlaceHold(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!reason.trim()) {
      setError('A reason is required to place a hold.');
      return;
    }
    if (!capId) return;

    const tx = new Transaction();
    tx.moveCall({
      target: target('place_hold'),
      arguments: [
        tx.object(capId),
        tx.object(batch.objectId),
        tx.pure.string(reason.trim()),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          setReason('');
          onChanged();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  function handleReleaseHold() {
    setError(null);
    if (!capId) return;

    const tx = new Transaction();
    tx.moveCall({
      target: target('release_hold'),
      arguments: [tx.object(capId), tx.object(batch.objectId), tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => onChanged(),
        onError: (err) => setError(err.message),
      },
    );
  }

  const canAct = Boolean(account && capId && !capLoading);

  return (
    <>
      {batch.isHeld ? (
        <div className="hold-banner hold-banner-active">
          <strong>⚠ ON HOLD</strong>
          <p>
            Reason: "{batch.holdReason}" — placed by{' '}
            <span className="code-chip">{batch.heldBy}</span> at{' '}
            {new Date(batch.heldAtMs).toLocaleString()}. No new checkpoints can be recorded until
            this is released.
          </p>
          {error && <p className="error-text">{error}</p>}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleReleaseHold}
            disabled={!canAct || isPending}
          >
            {isPending ? 'Releasing…' : 'Release hold'}
          </button>
          {!account && <p className="helper-text">Connect a wallet to release this hold.</p>}
          {account && !capLoading && !capId && (
            <p className="helper-text">
              Your connected wallet does not hold a Regulator Cap, so it cannot release this hold.
            </p>
          )}
        </div>
      ) : (
        <div className="hold-banner">
          <form onSubmit={handlePlaceHold}>
            <div className="field">
              <label htmlFor="holdReason">Place a hold on this batch</label>
              <input
                id="holdReason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Suspected counterfeit — seal mismatch"
                disabled={!canAct || isPending}
              />
            </div>
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn btn-danger" disabled={!canAct || isPending}>
              {isPending ? 'Placing hold…' : 'Place hold'}
            </button>
            {!account && <p className="helper-text">Connect a wallet to place a hold.</p>}
            {account && !capLoading && !capId && (
              <p className="helper-text">
                Your connected wallet does not hold a Regulator Cap, so it cannot place a hold on
                this batch. Ask an existing regulator to mint you one.
              </p>
            )}
          </form>
          {capId && <MintCapForm capId={capId} onMinted={refetchCap} />}
        </div>
      )}

      {batch.holdHistory.length > 0 && <HoldHistoryList history={batch.holdHistory} />}
    </>
  );
}

/** Every past hold+release cycle for this batch, oldest first — evidence
 * that survives a release, unlike the "currently held" banner above. */
function HoldHistoryList({ history }: { history: BatchRecord['holdHistory'] }) {
  return (
    <details className="hold-history" open={history.some((h) => h.releasedBy === null)}>
      <summary className="helper-text" style={{ cursor: 'pointer' }}>
        Hold history ({history.length} {history.length === 1 ? 'entry' : 'entries'})
      </summary>
      <div className="ledger" style={{ marginTop: 12 }}>
        {history.map((h, i) => (
          <div className="ledger-entry" key={i}>
            <span className="ledger-dot">{i + 1}</span>
            <div className="ledger-role">{h.releasedBy === null ? 'Held (active)' : 'Held & released'}</div>
            <div className="ledger-meta">
              Placed by <span className="code-chip">{h.heldBy}</span> at{' '}
              {new Date(h.heldAtMs).toLocaleString()}
            </div>
            <div className="ledger-note">"{h.reason}"</div>
            {h.releasedBy !== null && (
              <div className="helper-text">
                Released by <span className="code-chip">{h.releasedBy}</span> at{' '}
                {h.releasedAtMs !== null ? new Date(h.releasedAtMs).toLocaleString() : 'unknown'}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/** Lets an existing RegulatorCap holder onboard another address. */
function MintCapForm({ capId, onMinted }: { capId: string; onMinted: () => void }) {
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function handleMint(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!recipient.trim()) {
      setError('An address is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('mint_regulator_cap'),
      arguments: [tx.object(capId), tx.pure.address(recipient.trim())],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          setSuccess(`Regulator Cap minted to ${recipient.trim()}.`);
          setRecipient('');
          onMinted();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  return (
    <details style={{ marginTop: 12 }}>
      <summary className="helper-text" style={{ cursor: 'pointer' }}>
        Grant regulator access to another address
      </summary>
      <form onSubmit={handleMint} style={{ marginTop: 8 }}>
        <div className="field">
          <label htmlFor="regulatorRecipient">Address to onboard</label>
          <input
            id="regulatorRecipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            disabled={isPending}
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        {success && <p className="success-banner">{success}</p>}
        <button type="submit" className="btn btn-secondary" disabled={isPending}>
          {isPending ? 'Minting…' : 'Mint Regulator Cap'}
        </button>
      </form>
    </details>
  );
}
