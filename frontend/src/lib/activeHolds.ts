import type { HoldCategory, HoldSeverity } from './types';

export interface ActiveHoldSummary {
  batchId: string;
  heldBy: string;
  reason: string;
  severity: HoldSeverity;
  category: HoldCategory;
  caseReference: string;
  heldAtMs: number;
}

interface TimestampedEvent {
  batchId: string;
  ts: number;
  data?: Record<string, unknown>;
}

/**
 * Reconstructs which batches are currently on hold from raw `BatchHeld` /
 * `BatchReleased` event pages (as returned by `suiClient.queryEvents`), by
 * finding each batch's most recent event and keeping only the ones whose
 * latest event is a hold with no later release. This is what makes the
 * "Active Holds" dashboard work without needing every Batch object ID
 * known in advance — it's built entirely from the public event log.
 *
 * Known limitation: only reasons over whatever page of events was fetched
 * (typically the most recent N) — a hold placed far enough in the past
 * that its event fell off that page won't appear, even if still active.
 */
export function computeActiveHolds(heldEvents: any[], releasedEvents: any[]): ActiveHoldSummary[] {
  const events: (TimestampedEvent & { kind: 'held' | 'released' })[] = [];

  for (const e of heldEvents) {
    const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
    const batchId = String(pj.batch_id ?? '');
    if (!batchId) continue;
    events.push({
      batchId,
      kind: 'held',
      ts: Number(pj.held_at_ms ?? e?.timestampMs ?? 0),
      data: pj,
    });
  }

  for (const e of releasedEvents) {
    const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
    const batchId = String(pj.batch_id ?? '');
    if (!batchId) continue;
    events.push({
      batchId,
      kind: 'released',
      ts: Number(pj.released_at_ms ?? e?.timestampMs ?? 0),
    });
  }

  const latestByBatch = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const existing = latestByBatch.get(event.batchId);
    if (!existing || event.ts >= existing.ts) {
      latestByBatch.set(event.batchId, event);
    }
  }

  const active: ActiveHoldSummary[] = [];
  for (const event of latestByBatch.values()) {
    if (event.kind !== 'held' || !event.data) continue;
    active.push({
      batchId: event.batchId,
      heldBy: String(event.data.held_by ?? ''),
      reason: String(event.data.reason ?? ''),
      severity: Number(event.data.severity ?? 0) as HoldSeverity,
      category: Number(event.data.category ?? 0) as HoldCategory,
      caseReference: String(event.data.case_reference ?? ''),
      heldAtMs: event.ts,
    });
  }

  return active.sort((a, b) => b.heldAtMs - a.heldAtMs);
}
