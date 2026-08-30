import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, PACKAGE_ID, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';
import { fetchAllEvents } from '../lib/activeHolds';
import { CodeChip } from './CodeChip';
import { explorerAddressUrl } from '../lib/explorer';

interface SuspicionPanelProps {
  batchId: string;
}

interface SuspicionReport {
  reporter: string;
  note: string;
  reportedAtMs: number;
}

/**
 * Permissionless "something looks wrong" tips on a batch — distinct from a
 * regulator's hold. Anyone can leave one (`report_suspicion` has no
 * registry check, same trust model as `add_checkpoint`); this panel both
 * submits new ones and lists existing ones for this exact batch, read by
 * pulling every `SuspicionReported` event and filtering client-side, since
 * there's no per-batch on-chain index of reports (same pattern as the
 * Active Holds dashboard).
 */
export function SuspicionPanel({ batchId }: SuspicionPanelProps) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['suspicionReports', PACKAGE_ID, batchId],
    queryFn: async () => {
      const events = await fetchAllEvents(client, `${PACKAGE_ID}::batch::SuspicionReported`);
      const reports: SuspicionReport[] = events
        .map((e) => {
          const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
          return {
            batchId: String(pj.batch_id ?? ''),
            reporter: String(pj.reporter ?? ''),
            note: String(pj.note ?? ''),
            reportedAtMs: Number(pj.reported_at_ms ?? e?.timestampMs ?? 0),
          };
        })
        .filter((r) => r.batchId === batchId)
        .sort((a, b) => b.reportedAtMs - a.reportedAtMs);
      return reports;
    },
  });

  const reports = data ?? [];

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!note.trim()) {
      setError('A note describing what looked suspicious is required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('report_suspicion'),
      arguments: [tx.object(batchId), tx.pure.string(note.trim()), tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Report submitted — recorded on-chain, publicly visible.');
          setNote('');
          refetch();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <div className="hold-banner" style={{ marginTop: 16 }}>
      <strong>Report this batch as suspicious</strong>
      <p className="helper-text" style={{ marginTop: 4 }}>
        Anyone can leave a tip — no wallet allow-listing required. This doesn't freeze anything by
        itself; it's a public signal a regulator can act on, not a verdict.
      </p>
      {error && <p className="error-text">{error}</p>}

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="suspicionNote">What looked wrong?</label>
          <input
            id="suspicionNote"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Packaging seal looked different from usual, blister pack colour was off"
            disabled={!account || isPending}
          />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={!account || isPending}>
          {isPending ? 'Submitting…' : 'Submit report'}
        </button>
      </form>
      {!account && <p className="helper-text">Connect a wallet to submit a report.</p>}

      {isLoading && <p className="helper-text" style={{ marginTop: 8 }}>Reading reports…</p>}
      {!isLoading && reports.length === 0 && (
        <p className="helper-text" style={{ marginTop: 8 }}>No reports yet for this batch.</p>
      )}
      {reports.length > 0 && (
        <div className="ledger" style={{ marginTop: 12 }}>
          {reports.map((r, i) => (
            <div className="ledger-entry" key={i}>
              <span className="ledger-dot">!</span>
              <div className="ledger-meta">
                <CodeChip value={r.reporter} href={explorerAddressUrl(r.reporter)} /> at{' '}
                {new Date(r.reportedAtMs).toLocaleString()}
              </div>
              <div className="ledger-note">"{r.note}"</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
