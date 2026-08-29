import { useSuiClientQuery } from '@mysten/dapp-kit';
import { PACKAGE_ID } from '../lib/network';
import { computeActiveHolds } from '../lib/activeHolds';
import { CategoryBadge, SeverityBadge } from './HoldControl';
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
  const heldQuery = useSuiClientQuery('queryEvents', {
    query: { MoveEventType: `${PACKAGE_ID}::batch::BatchHeld` },
    limit: 200,
    order: 'descending',
  });
  const releasedQuery = useSuiClientQuery('queryEvents', {
    query: { MoveEventType: `${PACKAGE_ID}::batch::BatchReleased` },
    limit: 200,
    order: 'descending',
  });

  const isLoading = heldQuery.isLoading || releasedQuery.isLoading;
  const isError = heldQuery.isError || releasedQuery.isError;

  const activeHolds =
    heldQuery.data && releasedQuery.data
      ? computeActiveHolds(heldQuery.data.data, releasedQuery.data.data)
      : [];

  return (
    <section className="panel">
      <h2>Active Holds &amp; Recalls</h2>
      <p className="panel-intro">
        Every batch currently frozen anywhere in the system — a public recall registry, not a
        per-item lookup tool. Built by reading on-chain hold events directly, so it works without
        already knowing any batch ID. No wallet needed. Shows activity from the most recent 200
        hold events; a hold old enough to fall off that window won't appear here even if still
        active.
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
                <span className="code-chip">{h.heldBy}</span> at {new Date(h.heldAtMs).toLocaleString()}
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
