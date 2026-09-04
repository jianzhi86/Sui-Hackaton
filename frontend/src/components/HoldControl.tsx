import { useState, type FormEvent } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';
import { CodeChip } from './CodeChip';
import { explorerAddressUrl } from '../lib/explorer';
import {
  CATEGORY_COLD_CHAIN_BREACH,
  CATEGORY_COUNTERFEIT,
  CATEGORY_LABELING_ERROR,
  CATEGORY_OTHER,
  CATEGORY_QUALITY_DEFECT,
  SEVERITY_ADVISORY,
  SEVERITY_CRITICAL,
  SEVERITY_RECALL,
  type BatchRecord,
  type HoldCategory,
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

export function SeverityBadge({ severity }: { severity: HoldSeverity }) {
  return <span className={SEVERITY_CLASSES[severity]}>{SEVERITY_LABELS[severity]}</span>;
}

const CATEGORY_LABELS: Record<HoldCategory, string> = {
  1: 'Counterfeit',
  2: 'Quality Defect',
  3: 'Labeling Error',
  4: 'Cold-Chain Breach',
  5: 'Other',
};

export function CategoryBadge({ category }: { category: HoldCategory }) {
  return <span className="severity-badge" style={{ color: 'var(--ink-soft)' }}>{CATEGORY_LABELS[category]}</span>;
}

/**
 * How long a hold can sit active before the UI flags it as overdue for
 * review. Scaled by severity — a critical stop-sale hold going a full week
 * without anyone revisiting it is a much bigger problem than an advisory
 * doing the same. This is purely a UI nudge (nothing on-chain enforces a
 * review deadline); it exists so nothing freezes and gets forgotten.
 */
const STALE_THRESHOLD_MS: Record<HoldSeverity, number> = {
  3: 24 * 60 * 60 * 1000, // Critical: 1 day
  2: 7 * 24 * 60 * 60 * 1000, // Recall: 7 days
  1: 30 * 24 * 60 * 60 * 1000, // Advisory: 30 days
};

function formatDuration(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function StaleHoldBadge({
  heldAtMs,
  severity,
  escalated,
}: {
  heldAtMs: number;
  severity: HoldSeverity;
  escalated: boolean;
}) {
  const age = Date.now() - heldAtMs;
  if (escalated) {
    return (
      <span
        className="severity-badge severity-critical"
        title="Recorded on-chain via escalate_stale_hold — a permanent, public fact, not just a client-side badge."
      >
        🚨 Escalated — overdue for review ({formatDuration(age)} since held)
      </span>
    );
  }
  if (age < STALE_THRESHOLD_MS[severity]) return null;
  return (
    <span
      className="severity-badge severity-critical"
      title="Not yet recorded on-chain — anyone can flag it below."
    >
      ⏰ Overdue for review ({formatDuration(age)} since held)
    </span>
  );
}

interface HoldControlProps {
  batch: BatchRecord;
  onChanged: () => void;
}

/**
 * Lets any connected wallet place or release a hold on a batch. `place_hold`
 * freezes the on-chain custody chain: `add_checkpoint` aborts while
 * `is_held` is true, so this isn't just a cosmetic flag.
 */
export function HoldControl({ batch, onChanged }: HoldControlProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [severity, setSeverity] = useState<HoldSeverity>(SEVERITY_RECALL);
  const [category, setCategory] = useState<HoldCategory>(CATEGORY_QUALITY_DEFECT);
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

    const tx = new Transaction();
    tx.moveCall({
      target: target('place_hold'),
      arguments: [
        tx.object(batch.objectId),
        tx.pure.string(reason.trim()),
        tx.pure.u8(severity),
        tx.pure.u8(category),
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
          setCategory(CATEGORY_QUALITY_DEFECT);
          toast.success('Hold placed. Sales and checkpoints are now blocked for this batch.');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
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

    const tx = new Transaction();
    tx.moveCall({
      target: target('release_hold'),
      arguments: [
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
          toast.success('Hold released.');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleProposeRelease(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!releaseNote.trim()) {
      setError('A release note is required — explain why it is safe to unfreeze this batch.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('propose_release'),
      arguments: [
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
          toast.success('Release proposed. Waiting on a second, different regulator to confirm.');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleConfirmRelease() {
    setError(null);

    const tx = new Transaction();
    tx.moveCall({
      target: target('confirm_release'),
      arguments: [tx.object(batch.objectId), tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Release confirmed. This hold is now lifted.');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleEscalate() {
    setError(null);

    const tx = new Transaction();
    tx.moveCall({
      target: target('escalate_stale_hold'),
      arguments: [tx.object(batch.objectId), tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Hold flagged as overdue for review — recorded on-chain, permanently.');
          onChanged();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  const canAct = Boolean(account);
  const isCritical = batch.holdSeverity === SEVERITY_CRITICAL;
  const isProposer = Boolean(account && batch.pendingReleaseBy === account.address);
  const isOverdue =
    batch.isHeld && Date.now() - batch.heldAtMs >= STALE_THRESHOLD_MS[batch.holdSeverity as HoldSeverity];

  return (
    <>
      {batch.isHeld ? (
        <div className="hold-banner hold-banner-active">
          <strong>⚠ ON HOLD</strong> <SeverityBadge severity={batch.holdSeverity as HoldSeverity} />{' '}
          <CategoryBadge category={batch.holdCategory as HoldCategory} />{' '}
          <StaleHoldBadge
            heldAtMs={batch.heldAtMs}
            severity={batch.holdSeverity as HoldSeverity}
            escalated={batch.holdEscalated}
          />{' '}
          {isOverdue && !batch.holdEscalated && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleEscalate}
              disabled={!account || isPending}
              title="Anyone can call this — it only records an already-public fact (this hold has passed its review window) on-chain."
            >
              {isPending ? 'Flagging…' : 'Flag as overdue (on-chain)'}
            </button>
          )}
          <p>
            Reason: "{batch.holdReason}" — case <span className="code-chip">{batch.holdCaseReference}</span>{' '}
            — placed by <CodeChip value={batch.heldBy} href={explorerAddressUrl(batch.heldBy)} /> at{' '}
            {new Date(batch.heldAtMs).toLocaleString()}. No new checkpoints, sale QRs, or payments
            can happen until this is released.
          </p>
          {error && <p className="error-text">{error}</p>}

          {isCritical ? (
            <>
              <p className="helper-text">
                Critical holds can't be released by one person — this needs a second, different
                listed regulator to independently confirm.
              </p>

              {batch.pendingReleaseBy ? (
                <div>
                  <p className="helper-text">
                    Release proposed by{' '}
                    <CodeChip value={batch.pendingReleaseBy} href={explorerAddressUrl(batch.pendingReleaseBy)} />:
                    "{batch.pendingReleaseNote}". Awaiting confirmation from a <em>different</em>{' '}
                    regulator.
                  </p>
                  {isProposer ? (
                    <p className="error-text">
                      You proposed this release — a different regulator must confirm it, not you.
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={handleConfirmRelease}
                      disabled={!canAct || isPending}
                    >
                      {isPending ? 'Confirming…' : 'Confirm release (as second regulator)'}
                    </button>
                  )}
                </div>
              ) : !confirmingRelease ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirmingRelease(true)}
                  disabled={!canAct || isPending}
                >
                  Propose release
                </button>
              ) : (
                <form onSubmit={handleProposeRelease}>
                  <div className="field">
                    <label htmlFor="releaseNote">Why is it safe to release this hold?</label>
                    <input
                      id="releaseNote"
                      value={releaseNote}
                      onChange={(e) => setReleaseNote(e.target.value)}
                      placeholder="e.g. Independent lab confirmed the product is genuine"
                      disabled={!canAct || isPending}
                      autoFocus
                    />
                  </div>
                  <button type="submit" className="btn btn-danger" disabled={!canAct || isPending}>
                    {isPending ? 'Proposing…' : 'Propose release'}
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
            </>
          ) : !confirmingRelease ? (
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
                <label htmlFor="holdCategory">Category</label>
                <select
                  id="holdCategory"
                  value={category}
                  onChange={(e) => setCategory(Number(e.target.value) as HoldCategory)}
                  disabled={!canAct || isPending}
                >
                  <option value={CATEGORY_COUNTERFEIT}>Counterfeit</option>
                  <option value={CATEGORY_QUALITY_DEFECT}>Quality Defect</option>
                  <option value={CATEGORY_LABELING_ERROR}>Labeling Error</option>
                  <option value={CATEGORY_COLD_CHAIN_BREACH}>Cold-Chain Breach</option>
                  <option value={CATEGORY_OTHER}>Other</option>
                </select>
              </div>
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
            {error && <p className="error-text">{error}</p>}
            <button type="submit" className="btn btn-danger" disabled={!canAct || isPending}>
              {isPending ? 'Placing hold…' : 'Place hold'}
            </button>
            {!account && <p className="helper-text">Connect a wallet to place a hold.</p>}
          </form>
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
              {h.releasedBy === null ? 'Held (active)' : 'Held & released'} <SeverityBadge severity={h.severity} />{' '}
              <CategoryBadge category={h.category} />
            </div>
            <div className="ledger-meta">
              Case <span className="code-chip">{h.caseReference}</span> · placed by{' '}
              <CodeChip value={h.heldBy} href={explorerAddressUrl(h.heldBy)} /> at{' '}
              {new Date(h.heldAtMs).toLocaleString()}
            </div>
            <div className="ledger-note">"{h.reason}"</div>
            {h.releasedBy !== null && (
              <div className="helper-text">
                {h.coReleasedBy ? (
                  <>
                    Release proposed by <CodeChip value={h.coReleasedBy} href={explorerAddressUrl(h.coReleasedBy)} />,
                    confirmed by <CodeChip value={h.releasedBy} href={explorerAddressUrl(h.releasedBy)} />
                  </>
                ) : (
                  <>Released by <CodeChip value={h.releasedBy} href={explorerAddressUrl(h.releasedBy)} /></>
                )}{' '}
                at {h.releasedAtMs !== null ? new Date(h.releasedAtMs).toLocaleString() : 'unknown'}
                {h.releaseNote && <> — "{h.releaseNote}"</>}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

