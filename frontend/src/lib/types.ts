export interface Checkpoint {
  actor: string;
  role: string;
  location: string;
  timestampMs: number;
  note: string;
}

export interface HoldRecord {
  heldBy: string;
  reason: string;
  heldAtMs: number;
  releasedBy: string | null;
  releasedAtMs: number | null;
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
