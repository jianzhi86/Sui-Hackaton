import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, PACKAGE_ID, REGISTRY_OBJECT_ID, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useIsListed } from '../lib/registry';
import { useToast } from '../lib/toast';
import { fetchAllEvents } from '../lib/activeHolds';
import { CodeChip } from './CodeChip';
import { explorerAddressUrl } from '../lib/explorer';

interface SuspicionPanelProps {
  batchId: string;
}

interface SuspicionReportRow {
  reportId: string;
  reporter: string;
  note: string;
  bondAmountSui: number;
  reportedAtMs: number;
  open: boolean;
}

/**
 * Permissionless "something looks wrong" tips on a batch — distinct from a
 * regulator's hold. Anyone can leave one for a small bonded amount of SUI
 * (`report_suspicion` has no registry check, same trust model as
 * `add_checkpoint`, but the bond deters flooding the feed for free); a
 * listed regulator can later confirm it (bond refunded) or reject it (bond
 * forfeited to them). This panel submits new reports, lists existing ones
 * for this batch, and shows confirm/reject controls for regulators —
 * "open" status is inferred by checking which report IDs have since shown
 * up in a `SuspicionConfirmed`/`SuspicionRejected` event, since there's no
 * per-batch on-chain index of reports (same pattern as Active Holds).
 */
export function SuspicionPanel({ batchId }: SuspicionPanelProps) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const { isListed: isRegulator } = useIsListed(REGISTRY_OBJECT_ID, 'regulators');
  const [note, setNote] = useState('');
  const [bondSui, setBondSui] = useState('0.1');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['suspicionReports', PACKAGE_ID, batchId],
    queryFn: async () => {
      const [reported, confirmed, rejected] = await Promise.all([
        fetchAllEvents(client, `${PACKAGE_ID}::batch::SuspicionReported`),
        fetchAllEvents(client, `${PACKAGE_ID}::batch::SuspicionConfirmed`),
        fetchAllEvents(client, `${PACKAGE_ID}::batch::SuspicionRejected`),
      ]);

      const closedIds = new Set<string>();
      for (const e of [...confirmed, ...rejected]) {
        const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
        if (pj.report_id) closedIds.add(String(pj.report_id));
      }

      const reports: SuspicionReportRow[] = reported
        .map((e) => {
          const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
          return {
            batchId: String(pj.batch_id ?? ''),
            reportId: String(pj.report_id ?? ''),
            reporter: String(pj.reporter ?? ''),
            note: String(pj.note ?? ''),
            bondAmountSui: Number(pj.bond_amount ?? 0) / Number(MIST_PER_SUI),
            reportedAtMs: Number(pj.reported_at_ms ?? e?.timestampMs ?? 0),
            open: !closedIds.has(String(pj.report_id ?? '')),
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
    const bondNum = Number(bondSui);
    if (!bondSui.trim() || !Number.isFinite(bondNum) || bondNum <= 0) {
      setError('A positive bond amount is required — it discourages flooding the report feed for free.');
      return;
    }
    const bondMist = BigInt(Math.round(bondNum * Number(MIST_PER_SUI)));

    const tx = new Transaction();
    const [bondCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(bondMist)]);
    tx.moveCall({
      target: target('report_suspicion'),
      arguments: [tx.object(batchId), tx.pure.string(note.trim()), bondCoin, tx.object(CLOCK_OBJECT_ID)],
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

  function handleConfirm(reportId: string) {
    const tx = new Transaction();
    tx.moveCall({
      target: target('confirm_suspicion'),
      arguments: [tx.object(reportId), tx.object(REGISTRY_OBJECT_ID), tx.object(CLOCK_OBJECT_ID)],
    });
    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Report confirmed — bond refunded to the reporter.');
          refetch();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleReject(reportId: string) {
    const tx = new Transaction();
    tx.moveCall({
      target: target('reject_suspicion'),
      arguments: [tx.object(reportId), tx.object(REGISTRY_OBJECT_ID), tx.object(CLOCK_OBJECT_ID)],
    });
    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: () => {
          toast.success('Report rejected — bond forfeited to you.');
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
        Anyone can leave a tip for a small bonded amount of SUI — no wallet allow-listing required.
        This doesn't freeze anything by itself; it's a public signal a regulator can confirm (bond
        refunded) or reject (bond forfeited to them) as spam.
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
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="bondSui">Bond (SUI)</label>
          <input
            id="bondSui"
            type="number"
            min="0"
            step="0.01"
            value={bondSui}
            onChange={(e) => setBondSui(e.target.value)}
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
          {reports.map((r) => (
            <div className="ledger-entry" key={r.reportId}>
              <span className="ledger-dot">!</span>
              <div className="ledger-meta">
                <CodeChip value={r.reporter} href={explorerAddressUrl(r.reporter)} /> at{' '}
                {new Date(r.reportedAtMs).toLocaleString()} · bond {r.bondAmountSui} SUI ·{' '}
                {r.open ? 'open' : 'closed'}
              </div>
              <div className="ledger-note">"{r.note}"</div>
              {r.open && isRegulator && (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleConfirm(r.reportId)}
                    disabled={isPending}
                  >
                    Confirm (refund bond)
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    style={{ marginLeft: 8 }}
                    onClick={() => handleReject(r.reportId)}
                    disabled={isPending}
                  >
                    Reject (forfeit bond to me)
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
