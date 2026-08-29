import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, PACKAGE_ID, REGISTRY_OBJECT_ID, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
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

function StaleHoldBadge({ heldAtMs, severity }: { heldAtMs: number; severity: HoldSeverity }) {
  const age = Date.now() - heldAtMs;
  if (age < STALE_THRESHOLD_MS[severity]) return null;
  return (
    <span className="severity-badge severity-critical" title="No on-chain deadline enforces this — it's a UI nudge only.">
      ⏰ Overdue for review ({formatDuration(age)} since held)
    </span>
  );
}

interface HoldControlProps {
  batch: BatchRecord;
  onChanged: () => void;
}

/**
 * Placing/releasing a hold requires the connected address to be listed in
 * the shared `RegulatorRegistry` (an allow-list, not a bearer capability
 * object — see the Move module doc comment for why that distinction
 * matters for revocation). This reads the registry's raw `regulators`
 * field (a `VecSet<address>`, which serializes as `{ contents: [...] }`)
 * directly — no need to call into Move for a plain field read.
 */
function useIsRegulator() {
  const account = useCurrentAccount();
  const { data, isLoading, refetch } = useSuiClientQuery(
    'getObject',
    { id: REGISTRY_OBJECT_ID, options: { showContent: true } },
    { staleTime: 0, refetchOnMount: 'always' },
  );

  const content = data?.data?.content;
  const regulators: string[] =
    content && content.dataType === 'moveObject'
      ? ((content.fields as any)?.regulators?.fields?.contents ?? [])
      : [];

  const isRegulator = Boolean(account && regulators.includes(account.address));
  return { isRegulator, regulators, isLoading, refetch };
}

/** Whether the connected wallet holds the `AdminCap` that can add/revoke
 * regulators. Unlike registry membership, this really is a bearer
 * capability object — see the Move module doc comment on `AdminCap`. */
function useAdminCap() {
  const account = useCurrentAccount();
  const { data, isLoading, refetch } = useSuiClientQuery(
    'getOwnedObjects',
    {
      owner: account?.address ?? '',
      filter: { StructType: `${PACKAGE_ID}::batch::AdminCap` },
      options: { showContent: false },
    },
    { enabled: Boolean(account) },
  );

  const adminCapId = data?.data?.[0]?.data?.objectId ?? null;
  return { adminCapId, isLoading, refetch };
}

/**
 * Lets a listed regulator place or release a hold on a batch. `place_hold`
 * freezes the on-chain custody chain: `add_checkpoint` aborts while
 * `is_held` is true, so this isn't just a cosmetic flag.
 */
export function HoldControl({ batch, onChanged }: HoldControlProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const { isRegulator, isLoading: regLoading } = useIsRegulator();
  const { adminCapId, refetch: refetchAdmin } = useAdminCap();
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
        tx.object(REGISTRY_OBJECT_ID),
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

    const tx = new Transaction();
    tx.moveCall({
      target: target('release_hold'),
      arguments: [
        tx.object(REGISTRY_OBJECT_ID),
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
        tx.object(REGISTRY_OBJECT_ID),
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

  function handleConfirmRelease() {
    setError(null);

    const tx = new Transaction();
    tx.moveCall({
      target: target('confirm_release'),
      arguments: [tx.object(REGISTRY_OBJECT_ID), tx.object(batch.objectId), tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => onChanged(),
        onError: (err) => setError(err.message),
      },
    );
  }

  const canAct = Boolean(account && isRegulator && !regLoading);
  const isCritical = batch.holdSeverity === SEVERITY_CRITICAL;
  const isProposer = Boolean(account && batch.pendingReleaseBy === account.address);

  return (
    <>
      {batch.isHeld ? (
        <div className="hold-banner hold-banner-active">
          <strong>⚠ ON HOLD</strong> <SeverityBadge severity={batch.holdSeverity as HoldSeverity} />{' '}
          <CategoryBadge category={batch.holdCategory as HoldCategory} />{' '}
          <StaleHoldBadge heldAtMs={batch.heldAtMs} severity={batch.holdSeverity as HoldSeverity} />
          <p>
            Reason: "{batch.holdReason}" — case <span className="code-chip">{batch.holdCaseReference}</span>{' '}
            — placed by <span className="code-chip">{batch.heldBy}</span> at{' '}
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
                    Release proposed by <span className="code-chip">{batch.pendingReleaseBy}</span>:
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
          {account && !regLoading && !isRegulator && (
            <p className="helper-text">
              Your connected wallet is not a listed regulator, so it cannot release this hold.
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
            {account && !regLoading && !isRegulator && (
              <p className="helper-text">
                Your connected wallet is not a listed regulator, so it cannot place a hold on this
                batch. Ask an admin to add your address to the registry.
              </p>
            )}
          </form>
          {adminCapId && <AdminPanel adminCapId={adminCapId} onChanged={refetchAdmin} />}
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
              <span className="code-chip">{h.heldBy}</span> at {new Date(h.heldAtMs).toLocaleString()}
            </div>
            <div className="ledger-note">"{h.reason}"</div>
            {h.releasedBy !== null && (
              <div className="helper-text">
                {h.coReleasedBy ? (
                  <>
                    Release proposed by <span className="code-chip">{h.coReleasedBy}</span>, confirmed
                    by <span className="code-chip">{h.releasedBy}</span>
                  </>
                ) : (
                  <>Released by <span className="code-chip">{h.releasedBy}</span></>
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

/**
 * Lets the `AdminCap` holder add or revoke regulator addresses. This is
 * the actual point of the allow-list design over the old bearer-capability
 * model: revocation here is a real removal from the registry, not a
 * superseded-but-still-valid object sitting in someone's wallet forever.
 */
function AdminPanel({ adminCapId, onChanged }: { adminCapId: string; onChanged: () => void }) {
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const [addAddress, setAddAddress] = useState('');
  const [revokeAddress, setRevokeAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!addAddress.trim()) {
      setError('An address is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('admin_add_regulator'),
      arguments: [tx.object(adminCapId), tx.object(REGISTRY_OBJECT_ID), tx.pure.address(addAddress.trim())],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          setSuccess(`${addAddress.trim()} added as a regulator.`);
          setAddAddress('');
          onChanged();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  function handleRevoke(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!revokeAddress.trim()) {
      setError('An address is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('admin_revoke_regulator'),
      arguments: [tx.object(adminCapId), tx.object(REGISTRY_OBJECT_ID), tx.pure.address(revokeAddress.trim())],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          setSuccess(`${revokeAddress.trim()} revoked — that address can no longer place or release holds.`);
          setRevokeAddress('');
          onChanged();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  return (
    <details style={{ marginTop: 12 }}>
      <summary className="helper-text" style={{ cursor: 'pointer' }}>
        Admin: manage regulator access
      </summary>
      <div style={{ marginTop: 8 }}>
        <form onSubmit={handleAdd}>
          <div className="field">
            <label htmlFor="addRegulator">Add regulator address</label>
            <input
              id="addRegulator"
              value={addAddress}
              onChange={(e) => setAddAddress(e.target.value)}
              placeholder="0x…"
              disabled={isPending}
            />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={isPending}>
            {isPending ? 'Adding…' : 'Add regulator'}
          </button>
        </form>

        <form onSubmit={handleRevoke} style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="revokeRegulator">Revoke regulator address</label>
            <input
              id="revokeRegulator"
              value={revokeAddress}
              onChange={(e) => setRevokeAddress(e.target.value)}
              placeholder="0x…"
              disabled={isPending}
            />
          </div>
          <button type="submit" className="btn btn-danger" disabled={isPending}>
            {isPending ? 'Revoking…' : 'Revoke regulator'}
          </button>
        </form>

        {error && <p className="error-text">{error}</p>}
        {success && <p className="success-banner">{success}</p>}
      </div>
    </details>
  );
}
