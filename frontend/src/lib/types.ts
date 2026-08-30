export interface Checkpoint {
  actor: string;
  role: string;
  location: string;
  timestampMs: number;
  note: string;
  /** `null` when no temperature was measured at this checkpoint — distinct
   * from a real reading, including a real reading of 0°C. */
  temperatureC: number | null;
}

/** Mirrors the `SEVERITY_*` constants in `pharma_track.move`. */
export type HoldSeverity = 1 | 2 | 3;
export const SEVERITY_ADVISORY: HoldSeverity = 1;
export const SEVERITY_RECALL: HoldSeverity = 2;
export const SEVERITY_CRITICAL: HoldSeverity = 3;

/** Mirrors the `CATEGORY_*` constants in `pharma_track.move`. */
export type HoldCategory = 1 | 2 | 3 | 4 | 5;
export const CATEGORY_COUNTERFEIT: HoldCategory = 1;
export const CATEGORY_QUALITY_DEFECT: HoldCategory = 2;
export const CATEGORY_LABELING_ERROR: HoldCategory = 3;
export const CATEGORY_COLD_CHAIN_BREACH: HoldCategory = 4;
export const CATEGORY_OTHER: HoldCategory = 5;

export interface HoldRecord {
  heldBy: string;
  reason: string;
  severity: HoldSeverity;
  category: HoldCategory;
  caseReference: string;
  heldAtMs: number;
  releasedBy: string | null;
  releasedAtMs: number | null;
  releaseNote: string | null;
  /** Set only when released via the two-signer critical path — the address
   * that proposed the release, distinct from `releasedBy` (who confirmed it). */
  coReleasedBy: string | null;
  /** Whether this hold cycle was ever flagged via `escalate_stale_hold` as
   * having sat unaddressed past its review window, before it was eventually
   * released (or, if still active, so far). Permanent once set. */
  escalated: boolean;
}

export interface BatchRecord {
  objectId: string;
  batchCode: string;
  productName: string;
  manufacturer: string;
  createdAtMs: number;
  /** Absolute timestamp (ms) after which the batch can no longer be sold. */
  expiryMs: number;
  checkpoints: Checkpoint[];
  isHeld: boolean;
  holdReason: string;
  holdSeverity: HoldSeverity | 0;
  holdCategory: HoldCategory | 0;
  holdCaseReference: string;
  heldBy: string;
  heldAtMs: number;
  holdHistory: HoldRecord[];
  /** Address that proposed releasing the current critical hold, while a
   * second regulator's confirmation is still pending. `null` otherwise. */
  pendingReleaseBy: string | null;
  pendingReleaseNote: string | null;
  /** Whether the currently-active hold has been flagged, on-chain via
   * `escalate_stale_hold`, as overdue for review. `false` when there's no
   * active hold, or an active one just hasn't been flagged (yet). */
  holdEscalated: boolean;
  /** Remaining staked collateral (MIST) posted at registration — 0 once
   * withdrawn by the manufacturer or slashed by a Critical + Counterfeit
   * hold. See `withdraw_stake`/`place_hold` in the Move module. */
  stakeAmount: number;
}

export interface UnitRecord {
  objectId: string;
  batchId: string;
  price: number;
  manufacturer: string;
  mintedAtMs: number;
  /** SHA-256 hash (hex) of the one-time secret required to redeem this
   * Unit — not sensitive itself (it's a hash), but the raw secret that
   * hashes to it must never appear in the visible sale QR. */
  secretHash: string;
}

export interface ModelVerdict {
  model: string;
  requestId: string;
  /** 0-100, higher means more likely tampered/counterfeit. */
  riskScore: number;
  verdict: 'clear' | 'flag';
  reasoning: string;
}

export interface AnomalyReportResult {
  ruleFindings: string[];
  models: ModelVerdict[];
  consensus: 'clear' | 'flag' | 'needs_review' | 'unavailable';
  combinedRiskScore: number | null;
}
