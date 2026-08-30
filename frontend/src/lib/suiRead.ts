import { TEMPERATURE_OFFSET_C } from './network';
import type { BatchRecord, Checkpoint, HoldRecord, UnitRecord } from './types';

/**
 * Sui's JSON-RPC has two quirks this file exists to normalize:
 *  - u64 fields are returned as decimal strings (they don't always fit
 *    safely in a JS number), so timestamps need an explicit conversion.
 *  - nested Move structs (like our `Checkpoint`, which has `store` but not
 *    `key` so it lives inline inside `Batch` rather than as its own object)
 *    are represented as `{ type, fields }` wrappers, one level deeper than
 *    the outer object's own fields.
 */

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
}

/**
 * A Move `vector<u8>` (like `Unit.secret_hash`) comes back from JSON-RPC
 * as a plain array of byte numbers, not a string — this renders it as hex
 * for storage/display/comparison.
 */
function bytesToHex(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return (value as number[]).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unwrapFields(value: unknown): any {
  if (value && typeof value === 'object' && 'fields' in (value as Record<string, unknown>)) {
    return (value as { fields: unknown }).fields;
  }
  return value;
}

/**
 * Move's `Option<T>` (`{ vec: vector<T> }` under the hood) comes back from
 * JSON-RPC as `{ fields: { vec: [] } }` (none) or `{ fields: { vec: [x] } }`
 * (some x) — this pulls the single value out, or returns null.
 */
function unwrapOption<T>(value: unknown, map: (v: unknown) => T): T | null {
  const fields = unwrapFields(value) as Record<string, unknown> | undefined;
  const vec = (fields?.vec as unknown[]) ?? [];
  return vec.length > 0 ? map(vec[0]) : null;
}

/**
 * @param objectData the value returned by `suiClient.getObject({ id, options: { showContent: true } })`
 */
export function parseBatchObject(objectData: any): BatchRecord | null {
  const content = objectData?.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;

  const fields = content.fields as Record<string, unknown>;
  const rawCheckpoints = (fields.checkpoints as unknown[]) ?? [];

  const checkpoints: Checkpoint[] = rawCheckpoints.map((raw) => {
    const cp = unwrapFields(raw) as Record<string, unknown>;
    return {
      actor: String(cp.actor ?? ''),
      role: String(cp.role ?? ''),
      location: String(cp.location ?? ''),
      timestampMs: asNumber(cp.timestamp_ms),
      note: String(cp.note ?? ''),
      temperatureC: Boolean(cp.has_temperature)
        ? asNumber(cp.temperature_c_offset) - TEMPERATURE_OFFSET_C
        : null,
    };
  });

  const rawHoldHistory = (fields.hold_history as unknown[]) ?? [];
  const holdHistory: HoldRecord[] = rawHoldHistory.map((raw) => {
    const r = unwrapFields(raw) as Record<string, unknown>;
    return {
      heldBy: String(r.held_by ?? ''),
      reason: String(r.reason ?? ''),
      severity: asNumber(r.severity) as HoldRecord['severity'],
      category: asNumber(r.category) as HoldRecord['category'],
      caseReference: String(r.case_reference ?? ''),
      heldAtMs: asNumber(r.held_at_ms),
      releasedBy: unwrapOption(r.released_by, (v) => String(v)),
      releasedAtMs: unwrapOption(r.released_at_ms, (v) => asNumber(v)),
      releaseNote: unwrapOption(r.release_note, (v) => String(v)),
      coReleasedBy: unwrapOption(r.co_released_by, (v) => String(v)),
      escalated: Boolean(r.escalated),
    };
  });

  return {
    objectId: objectData.data.objectId,
    batchCode: String(fields.batch_code ?? ''),
    productName: String(fields.product_name ?? ''),
    manufacturer: String(fields.manufacturer ?? ''),
    createdAtMs: asNumber(fields.created_at_ms),
    expiryMs: asNumber(fields.expiry_ms),
    checkpoints,
    isHeld: Boolean(fields.is_held),
    holdReason: String(fields.hold_reason ?? ''),
    holdSeverity: asNumber(fields.hold_severity) as BatchRecord['holdSeverity'],
    holdCategory: asNumber(fields.hold_category) as BatchRecord['holdCategory'],
    holdCaseReference: String(fields.hold_case_reference ?? ''),
    heldBy: String(fields.held_by ?? ''),
    heldAtMs: asNumber(fields.held_at_ms),
    holdHistory,
    pendingReleaseBy: unwrapOption(fields.pending_release_by, (v) => String(v)),
    pendingReleaseNote: unwrapOption(fields.pending_release_note, (v) => String(v)),
    holdEscalated: Boolean(fields.hold_escalated),
    stakeAmount: asNumber(unwrapFields(fields.stake)?.value),
  };
}

/**
 * @param objectData the value returned by `suiClient.getObject({ id, options: { showContent: true } })`
 * Returns `null` both when the ID is malformed and when the `Unit` has
 * already been burned by `purchase_and_burn` — from the frontend's point of
 * view those look identical (object not found), which is exactly what
 * makes the QR single-use.
 */
export function parseUnitObject(objectData: any): UnitRecord | null {
  const content = objectData?.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;

  const fields = content.fields as Record<string, unknown>;

  return {
    objectId: objectData.data.objectId,
    batchId: String(fields.batch_id ?? ''),
    price: asNumber(fields.price),
    manufacturer: String(fields.manufacturer ?? ''),
    mintedAtMs: asNumber(fields.minted_at_ms),
    secretHash: bytesToHex(fields.secret_hash),
  };
}
