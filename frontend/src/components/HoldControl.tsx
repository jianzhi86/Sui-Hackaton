import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, PACKAGE_ID, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import {
  SEVERITY_ADVISORY,
  SEVERITY_CRITICAL,
  SEVERITY_RECALL,
  type BatchRecord,
  type HoldSeverity,
} from '../lib/types';

const SEVERITY_LABELS: Record<HoldSeverity, string> = {
  1: 'Advisory',
  2: 'Recall',
  3: 'Critical — stop sale',
};

const SEVERITY_CLASSES: Record<HoldSeverity, string> = {
  1: 'severity-badge severity-advisory',
  2: 'severity-badge severity-recall',
  3: 'severity-badge severity-critical',
};

function SeverityBadge({ severity }: { severity: HoldSeverity }) {
  return <span className={SEVERITY_CLASSES[severity]}>{SEVERITY_LABELS[severity]}</span>;
}

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
  const [severity, setSeverity] = useState<HoldSeverity>(SEVERITY_RECALL);
  const [caseReference, setCaseReference] = useState('');
  const [releaseNote, setReleaseNote] = useState('');
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handlePlaceHold(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!reason.trim()) {
      setError('A reason is required to place a hold.');
      return;
    }
    if (!caseReference.trim()) {
      setError('A case/investigation reference is required — this is what ties the hold back to your paperwork.');
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
        tx.pure.u8(severity),
        tx.pure.string(caseReference.trim()),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          setReason('');
          setCaseReference('');
          setSeverity(SEVERITY_RECALL);
          onChanged();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  function handleReleaseHold(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!releaseNote.trim()) {
      setError('A release note is required — explain why it is safe to unfreeze this batch.');
      return;
    }
    if (!capId) return;

    const tx = new Transaction();
    tx.moveCall({
      target: target('release_hold'),
      arguments: [
        tx.object(capId),
        tx.object(batch.objectId),
        tx.pure.string(releaseNote.trim()),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          setReleaseNote('');
          setConfirmingRelease(false);
          onChanged();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  const canAct = Boolean(account && capId && !capLoading);

  return (
    <>
      {batch.isHeld ? (
        <div className="hold-banner hold-banner-active">
          <strong>⚠ ON HOLD</strong> <SeverityBadge severity={batch.holdSeverity as HoldSeverity} />
          <p>
            Reason: "{batch.holdReason}" — case <span className="code-chip">{batch.holdCaseReference}</span>{' '}
            — placed by <span className="code-chip">{batch.heldBy}</span> at{' '}
            {new Date(batch.heldAtMs).toLocaleString()}. No new checkpoints can be recorded until
            this is released.
          </p>
          {error && <p className="error-text">{error}</p>}

          {!confirmingRelease ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmingRelease(true)}
              disabled={!canAct || isPending}
            >
              Release hold
            </button>
          ) : (
            <form onSubmit={handleReleaseHold}>
              <div className="field">
                <label htmlFor="releaseNote">Why is it safe to release this hold?</label>
                <input
                  id="releaseNote"
                  value={releaseNote}
                  onChange={(e) => setReleaseNote(e.target.value)}
                  placeholder="e.g. Investigation closed — counterfeit ruled out, manifest matches"
                  disabled={!canAct || isPending}
                  autoFocus
                />
              </div>
              <button type="submit" className="btn btn-danger" disabled={!canAct || isPending}>
                {isPending ? 'Releasing…' : 'Confirm release'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: 8 }}
                onClick={() => {
                  setConfirmingRelease(false);
                  setReleaseNote('');
                  setError(null);
                }}
                disabled={isPending}
              >
                Cancel
              </button>
            </form>
          )}

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
            <div className="field-row">
              <div className="field">
                <label htmlFor="holdSeverity">Severity</label>
                <select
                  id="holdSeverity"
                  value={severity}
                  onChange={(e) => setSeverity(Number(e.target.value) as HoldSeverity)}
                  disabled={!canAct || isPending}
                >
                  <option value={SEVERITY_ADVISORY}>Advisory</option>
                  <option value={SEVERITY_RECALL}>Recall</option>
                  <option value={SEVERITY_CRITICAL}>Critical — stop sale</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="caseReference">Case / investigation reference</label>
                <input
                  id="caseReference"
                  value={caseReference}
                  onChange={(e) => setCaseReference(e.target.value)}
                  placeholder="e.g. MOH-2026-0417"
                  disabled={!canAct || isPending}
                />
              </div>
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
            <div className="ledger-role">
              {h.releasedBy === null ? 'Held (active)' : 'Held & released'} <SeverityBadge severity={h.severity} />
            </div>
            <div className="ledger-meta">
              Case <span className="code-chip">{h.caseReference}</span> · placed by{' '}
              <span className="code-chip">{h.heldBy}</span> at {new Date(h.heldAtMs).toLocaleString()}
            </div>
            <div className="ledger-note">"{h.reason}"</div>
            {h.releasedBy !== null && (
              <div className="helper-text">
                Released by <span className="code-chip">{h.releasedBy}</span> at{' '}
                {h.releasedAtMs !== null ? new Date(h.releasedAtMs).toLocaleString() : 'unknown'}
                {h.releaseNote && <> — "{h.releaseNote}"</>}
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
