import { useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { PACKAGE_ID } from '../lib/network';
import { fetchAllEvents } from '../lib/activeHolds';

interface Stats {
  batchesRegistered: number;
  checkpointsRecorded: number;
  unitsMinted: number;
  unitsSold: number;
  holdsPlaced: number;
  holdsReleased: number;
  activeHolds: number;
  avgReleaseHours: number | null;
  suspicionReports: number;
  stakeSlashedSui: number;
  stakeWithdrawnSui: number;
  totalStakedSui: number;
}

/**
 * Aggregate, system-wide numbers computed entirely from public events — no
 * new on-chain state, no wallet needed. Same "read events, compute
 * client-side" pattern as the Active Holds dashboard, just summarized
 * instead of listed. Exists so a judge/regulator/anyone can see "is this
 * thing actually being used" at a glance instead of having to browse
 * individual batches.
 */
export function StatsDashboard() {
  const client = useSuiClient();

  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['stats', PACKAGE_ID],
    queryFn: async (): Promise<Stats> => {
      const [created, checkpoints, minted, sold, held, released, suspicions, slashed, withdrawn] =
        await Promise.all([
          fetchAllEvents(client, `${PACKAGE_ID}::batch::BatchCreated`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::CheckpointAdded`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::UnitMinted`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::UnitSold`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::BatchHeld`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::BatchReleased`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::SuspicionReported`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::StakeSlashed`),
          fetchAllEvents(client, `${PACKAGE_ID}::batch::StakeWithdrawn`),
        ]);

      // Active holds = batches whose most recent held/released event is a
      // hold with no later release — same reasoning as computeActiveHolds,
      // but we only need the count here.
      const latestByBatch = new Map<string, { kind: 'held' | 'released'; ts: number }>();
      for (const e of held) {
        const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
        const batchId = String(pj.batch_id ?? '');
        if (!batchId) continue;
        const ts = Number(pj.held_at_ms ?? e?.timestampMs ?? 0);
        const existing = latestByBatch.get(batchId);
        if (!existing || ts >= existing.ts) latestByBatch.set(batchId, { kind: 'held', ts });
      }
      for (const e of released) {
        const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
        const batchId = String(pj.batch_id ?? '');
        if (!batchId) continue;
        const ts = Number(pj.released_at_ms ?? e?.timestampMs ?? 0);
        const existing = latestByBatch.get(batchId);
        if (!existing || ts >= existing.ts) latestByBatch.set(batchId, { kind: 'released', ts });
      }
      const activeHolds = [...latestByBatch.values()].filter((v) => v.kind === 'held').length;

      // Average time from a hold going up to it coming back down again,
      // across every released hold — pairs by nearest earlier `held` event
      // per batch, good enough for a summary stat without needing exact
      // hold_history matching (that's what the Verify page's ledger is for).
      const heldByBatch = new Map<string, number[]>();
      for (const e of held) {
        const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
        const batchId = String(pj.batch_id ?? '');
        if (!batchId) continue;
        const ts = Number(pj.held_at_ms ?? e?.timestampMs ?? 0);
        heldByBatch.set(batchId, [...(heldByBatch.get(batchId) ?? []), ts]);
      }
      const durationsMs: number[] = [];
      for (const e of released) {
        const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
        const batchId = String(pj.batch_id ?? '');
        if (!batchId) continue;
        const releasedTs = Number(pj.released_at_ms ?? e?.timestampMs ?? 0);
        const candidates = (heldByBatch.get(batchId) ?? []).filter((t) => t <= releasedTs);
        if (candidates.length === 0) continue;
        const nearestHeld = Math.max(...candidates);
        durationsMs.push(releasedTs - nearestHeld);
      }
      const avgReleaseHours =
        durationsMs.length > 0
          ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length / (1000 * 60 * 60)
          : null;

      const sumMist = (events: unknown[], field: string): number =>
        events.reduce((sum: number, e) => {
          const pj = ((e as { parsedJson?: Record<string, unknown> })?.parsedJson ?? {}) as Record<
            string,
            unknown
          >;
          return sum + Number(pj[field] ?? 0);
        }, 0);

      const totalStakedMist = sumMist(created, 'stake_amount');
      const slashedMist = sumMist(slashed, 'amount');
      const withdrawnMist = sumMist(withdrawn, 'amount');

      return {
        batchesRegistered: created.length,
        checkpointsRecorded: checkpoints.length,
        unitsMinted: minted.length,
        unitsSold: sold.length,
        holdsPlaced: held.length,
        holdsReleased: released.length,
        activeHolds,
        avgReleaseHours,
        suspicionReports: suspicions.length,
        stakeSlashedSui: slashedMist / Number(MIST_PER_SUI),
        stakeWithdrawnSui: withdrawnMist / Number(MIST_PER_SUI),
        totalStakedSui: totalStakedMist / Number(MIST_PER_SUI),
      };
    },
  });

  return (
    <section className="panel">
      <h2>System stats</h2>
      <p className="panel-intro">
        System-wide numbers computed entirely from public on-chain events — no wallet needed, and
        nothing here is a new piece of on-chain state, just a summary of what's already public.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button type="button" className="btn btn-secondary" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        {dataUpdatedAt > 0 && !isFetching && (
          <span className="helper-text">Last updated {new Date(dataUpdatedAt).toLocaleTimeString()}</span>
        )}
      </div>

      {isLoading && <p className="helper-text">Reading events from Sui…</p>}
      {isError && <p className="error-text">Could not read events from Sui. Try again shortly.</p>}

      {data && (
        <div className="stats-grid">
          <StatCard label="Batches registered" value={data.batchesRegistered} />
          <StatCard label="Checkpoints recorded" value={data.checkpointsRecorded} />
          <StatCard label="Sale QRs minted" value={data.unitsMinted} />
          <StatCard label="Units sold" value={data.unitsSold} />
          <StatCard label="Holds placed" value={data.holdsPlaced} />
          <StatCard label="Holds released" value={data.holdsReleased} />
          <StatCard label="Currently on hold" value={data.activeHolds} />
          <StatCard
            label="Avg. time to release"
            value={data.avgReleaseHours !== null ? `${data.avgReleaseHours.toFixed(1)}h` : '—'}
          />
          <StatCard label="Suspicion reports" value={data.suspicionReports} />
          <StatCard label="Total staked (ever)" value={`${data.totalStakedSui} SUI`} />
          <StatCard label="Stake slashed" value={`${data.stakeSlashedSui} SUI`} />
          <StatCard label="Stake withdrawn" value={`${data.stakeWithdrawnSui} SUI`} />
        </div>
      )}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
