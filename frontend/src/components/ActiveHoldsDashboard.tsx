import { useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { PACKAGE_ID } from '../lib/network';
import { computeActiveHolds, fetchAllEvents } from '../lib/activeHolds';
import { CategoryBadge, SeverityBadge } from './HoldControl';
import { CodeChip } from './CodeChip';
import { explorerAddressUrl } from '../lib/explorer';
import type { HoldCategory, HoldSeverity } from '../lib/types';

interface ActiveHoldsDashboardProps {
  onSelectBatch: (batchId: string) => void;
}

/**
 * A public "recall registry" — every batch currently on hold anywhere in
 * the system, built entirely from on-chain `BatchHeld`/`BatchReleased`
 * events. No wallet needed, and critically, no need to already know a
 * batch ID: the per-batch Verify page only shows you a hold if you go
 * looking for that exact batch, which isn't how a real recall notice
 * should work. This is the page a regulator, pharmacy, or curious
 * consumer would actually want to browse.
 */
export function ActiveHoldsDashboard({ onSelectBatch }: ActiveHoldsDashboardProps) {
  const client = useSuiClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['activeHolds', PACKAGE_ID],
    queryFn: async () => {
      const [held, released] = await Promise.all([
        fetchAllEvents(client, `${PACKAGE_ID}::batch::BatchHeld`),
        fetchAllEvents(client, `${PACKAGE_ID}::batch::BatchReleased`),
      ]);
      return computeActiveHolds(held, released);
    },
  });

  const activeHolds = data ?? [];

  return (
    <section className="panel">
      <h2>Active Holds &amp; Recalls</h2>
      <p className="panel-intro">
        Every batch currently frozen anywhere in the system — a public recall registry, not a
        per-item lookup tool. Built by reading on-chain hold events directly, so it works without
        already knowing any batch ID. No wallet needed. Pages through up to 4,000 hold/release
        events (20 pages of 200) rather than silently stopping at the first page.
      </p>

      {isLoading && <p className="helper-text">Reading hold events from Sui…</p>}
      {isError && <p className="error-text">Could not read hold events from Sui. Try again shortly.</p>}

      {!isLoading && !isError && activeHolds.length === 0 && (
        <p className="success-banner">No batches are currently on hold.</p>
      )}

      {activeHolds.length > 0 && (
        <div className="ledger" style={{ marginTop: 16 }}>
          {activeHolds.map((h) => (
            <div className="ledger-entry" key={h.batchId}>
              <span className="ledger-dot">⚠</span>
              <div className="ledger-role">
                <SeverityBadge severity={h.severity as HoldSeverity} />{' '}
                <CategoryBadge category={h.category as HoldCategory} />
              </div>
              <div className="ledger-meta">
                Case <span className="code-chip">{h.caseReference}</span> · held by{' '}
                <CodeChip value={h.heldBy} href={explorerAddressUrl(h.heldBy)} /> at{' '}
                {new Date(h.heldAtMs).toLocaleString()}
              </div>
              <div className="ledger-note">"{h.reason}"</div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 8 }}
                onClick={() => onSelectBatch(h.batchId)}
              >
                View batch
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
