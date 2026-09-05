import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, MIN_SUSPICION_BOND_MIST, PACKAGE_ID, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';
import { fetchAllEvents } from '../lib/activeHolds';
import { CodeChip } from './CodeChip';
import { explorerAddressUrl } from '../lib/explorer';
import { mistPreview } from '../lib/formatSui';
import { ConnectWalletBanner } from './ConnectWalletBanner';

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
 * hold. Anyone can leave one for a bonded amount of SUI (`report_suspicion`
 * has no access check, same trust model as `add_checkpoint`, but the bond
 * deters flooding the feed for free); anyone can later confirm it (bond
 * refunded) or reject it (bond forfeited to them). This panel submits new
 * reports, lists existing ones for this batch, and shows confirm/reject
 * controls — "open" status is inferred by checking which report IDs have
 * since shown up in a `SuspicionConfirmed`/`SuspicionRejected` event, since
 * there's no per-batch on-chain index of reports (same pattern as Active
 * Holds).
 */
export function SuspicionPanel({ batchId }: SuspicionPanelProps) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
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
    const bondMist = BigInt(Math.round(bondNum * Number(MIST_PER_SUI)));
    if (!bondSui.trim() || !Number.isFinite(bondNum) || bondMist < BigInt(MIN_SUSPICION_BOND_MIST)) {
      setError(
        `A bond of at least ${MIN_SUSPICION_BOND_MIST / Number(MIST_PER_SUI)} SUI is required — it discourages flooding the report feed for free.`,
      );
      return;
    }

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
      arguments: [tx.object(reportId), tx.object(CLOCK_OBJECT_ID)],
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
    if (!window.confirm('Reject this report as spam? The reporter\'s bond is forfeited to you and this cannot be undone.')) {
      return;
    }
    const tx = new Transaction();
    tx.moveCall({
      target: target('reject_suspicion'),
      arguments: [tx.object(reportId), tx.object(CLOCK_OBJECT_ID)],
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
        Anyone can leave a tip for a bonded amount of at least {MIN_SUSPICION_BOND_MIST / Number(MIST_PER_SUI)} SUI.
        This doesn't freeze anything by itself; it's a public signal, and anyone can confirm it
        (bond refunded) or reject it (bond forfeited to them) as spam.
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
            min={MIN_SUSPICION_BOND_MIST / Number(MIST_PER_SUI)}
            step="0.01"
            value={bondSui}
            onChange={(e) => setBondSui(e.target.value)}
            disabled={!account || isPending}
          />
          {Number(bondSui) > 0 && (
            <p className="helper-text" style={{ marginTop: 2 }}>{mistPreview(Number(bondSui))}</p>
          )}
        </div>
        <button type="submit" className="btn btn-secondary" disabled={!account || isPending}>
          {isPending ? 'Submitting…' : 'Submit report'}
        </button>
      </form>
      {!account && <ConnectWalletBanner action="submit a report" />}

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
              {r.open && account && (
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
