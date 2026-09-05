import type { HoldCategory, HoldSeverity } from './types';

/** Loosely typed on purpose — dapp-kit's `useSuiClient()` return type
 * varies across its legacy JSON-RPC vs. newer gRPC client paths (see the
 * note in network.ts), and this only needs the one `queryEvents` method
 * both expose with a compatible shape. */
interface EventQueryClient {
  queryEvents(input: any): Promise<{ data: any[]; hasNextPage: boolean; nextCursor?: unknown }>;
}

/**
 * Safety cap on how many pages of events `fetchAllEvents` will follow —
 * without this, a system with an enormous hold history could make the
 * dashboard page forever. 20 pages of 200 events each (4000 total) is
 * generous for a demo-scale deployment; a production version would want
 * proper incremental pagination (e.g. only fetching pages newer than the
 * last render) instead of refetching everything on each load.
 */
const MAX_EVENT_PAGES = 20;
const EVENTS_PER_PAGE = 200;

/**
 * Follows `queryEvents`'s cursor until exhausted or `MAX_EVENT_PAGES` is
 * hit, returning every event seen. Replaces an earlier single-page
 * `useSuiClientQuery` call that silently missed any hold event older than
 * the first 200 — this raises that ceiling by 20x and makes the limit
 * explicit rather than an invisible truncation.
 */
export async function fetchAllEvents(client: EventQueryClient, moveEventType: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: any = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const result = await client.queryEvents({
      query: { MoveEventType: moveEventType },
      cursor,
      limit: EVENTS_PER_PAGE,
      order: 'descending',
    });
    all.push(...result.data);
    if (!result.hasNextPage) break;
    if (!result.nextCursor) throw new Error('Event history is incomplete: the server did not supply the next page cursor.');
    if (page === MAX_EVENT_PAGES - 1) throw new Error('Event history exceeds the supported range; a complete result cannot be shown.');
    cursor = result.nextCursor;
  }
  return all;
}

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
