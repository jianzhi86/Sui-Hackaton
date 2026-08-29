export interface Checkpoint {
  actor: string;
  role: string;
  location: string;
  timestampMs: number;
  note: string;
}

/** Mirrors the `SEVERITY_*` constants in `pharma_track.move`. */
export type HoldSeverity = 1 | 2 | 3;
export const SEVERITY_ADVISORY: HoldSeverity = 1;
export const SEVERITY_RECALL: HoldSeverity = 2;
export const SEVERITY_CRITICAL: HoldSeverity = 3;

export interface HoldRecord {
  heldBy: string;
  reason: string;
  severity: HoldSeverity;
  caseReference: string;
  heldAtMs: number;
  releasedBy: string | null;
  releasedAtMs: number | null;
  releaseNote: string | null;
}

export interface BatchRecord {
  objectId: string;
  batchCode: string;
  productName: string;
  manufacturer: string;
  createdAtMs: number;
  checkpoints: Checkpoint[];
  isHeld: boolean;
  holdReason: string;
  holdSeverity: HoldSeverity | 0;
  holdCaseReference: string;
  heldBy: string;
  heldAtMs: number;
  holdHistory: HoldRecord[];
}

export interface UnitRecord {
  objectId: string;
  batchId: string;
  price: number;
  manufacturer: string;
  mintedAtMs: number;
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
