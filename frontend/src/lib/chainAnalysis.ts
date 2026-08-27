import type { BatchRecord } from './types';

const EXPECTED_ORDER = ['manufacturer', 'distributor', 'pharmacy'];

// Flag a gap between consecutive checkpoints as suspicious if it's longer
// than this. In a real deployment this should vary by product — cold-chain
// biologics need a much tighter window than shelf-stable tablets.
const MAX_PLAUSIBLE_GAP_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/**
 * Fast, local, zero-cost checks over a batch's checkpoint history. These run
 * before (and independently of) the AI layer, and are shown on their own if
 * Gonka Router is unreachable, so the demo never goes blank on flaky wifi.
 */
export function analyzeChain(batch: BatchRecord): string[] {
  const findings: string[] = [];
  const cps = batch.checkpoints;

  if (batch.isHeld) {
    findings.push(
      `This batch is currently ON HOLD (reason: "${batch.holdReason}", placed by ${batch.heldBy} at ${new Date(batch.heldAtMs).toISOString()}) — treat as unverified until released.`,
    );
  }

  if (batch.holdHistory.length > 1) {
    findings.push(
      `This batch has been placed on hold ${batch.holdHistory.length} separate times — repeated holds on the same batch are a stronger signal than a single one.`,
    );
  }

  if (cps.length === 0) {
    findings.push('No checkpoints recorded yet — nothing has been scanned since manufacture.');
    return findings;
  }

  // 1. Timestamps should be monotonically increasing.
  for (let i = 1; i < cps.length; i++) {
    if (cps[i].timestampMs < cps[i - 1].timestampMs) {
      findings.push(
        `Checkpoint ${i + 1} ("${cps[i].role}") is timestamped before checkpoint ${i} ("${cps[i - 1].role}") — the recorded order and the clock disagree.`,
      );
    }
  }

  // 2. Implausibly large gaps between consecutive checkpoints.
  for (let i = 1; i < cps.length; i++) {
    const gap = cps[i].timestampMs - cps[i - 1].timestampMs;
    if (gap > MAX_PLAUSIBLE_GAP_MS) {
      const days = (gap / (1000 * 60 * 60 * 24)).toFixed(1);
      findings.push(
        `${days}-day gap between "${cps[i - 1].role}" and "${cps[i].role}" checkpoints — unusually long for this product.`,
      );
    }
  }

  // 3. Same role scanned twice in a row at the same location — a possible
  //    cloned label being scanned repeatedly at one point in the chain.
  for (let i = 1; i < cps.length; i++) {
    if (cps[i].role === cps[i - 1].role && cps[i].location === cps[i - 1].location) {
      findings.push(
        `"${cps[i].role}" at "${cps[i].location}" was scanned twice in a row — could be a duplicate scan or a cloned label.`,
      );
    }
  }

  // 4. A later expected step exists without an earlier one — soft signal
  //    only, since real chains can legitimately have more hops than this
  //    three-step model assumes.
  const roles = cps.map((c) => c.role.toLowerCase());
  const seenIndex = EXPECTED_ORDER.map((r) => roles.indexOf(r));
  for (let i = 1; i < seenIndex.length; i++) {
    if (seenIndex[i] !== -1 && seenIndex[i - 1] === -1) {
      findings.push(
        `A "${EXPECTED_ORDER[i]}" checkpoint exists but "${EXPECTED_ORDER[i - 1]}" was never recorded — a step in the expected chain appears to be missing.`,
      );
    }
  }

  return findings;
}
