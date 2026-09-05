import type { BatchRecord } from './types';

const EXPECTED_ORDER = ['manufacturer', 'distributor', 'pharmacy'];

// Flag a gap between consecutive checkpoints as suspicious if it's longer
// than this. In a real deployment this should vary by product — cold-chain
// biologics need a much tighter window than shelf-stable tablets.
const MAX_PLAUSIBLE_GAP_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

// Generic refrigerated-range bounds (matches the common 2-8°C "cold chain"
// band used for many vaccines/biologics). Real deployments should make
// this per-product — a frozen product's safe range looks nothing like a
// refrigerated one's — but a single fixed band is a reasonable MVP default
// for flagging obviously-out-of-range readings.
export const COLD_CHAIN_MIN_C = 2;
export const COLD_CHAIN_MAX_C = 8;

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

  // 4. Cold-chain temperature excursions — any recorded reading outside
  //    the generic refrigerated band. A real deployment would use a
  //    per-product range instead of one fixed band for every batch.
  for (let i = 0; i < cps.length; i++) {
    const temp = cps[i].temperatureC;
    if (temp === null) continue;
    if (temp < COLD_CHAIN_MIN_C || temp > COLD_CHAIN_MAX_C) {
      findings.push(
        `Checkpoint ${i + 1} ("${cps[i].role}" at "${cps[i].location}") recorded ${temp}°C — outside the ${COLD_CHAIN_MIN_C}-${COLD_CHAIN_MAX_C}°C cold-chain range. A sustained excursion can spoil a temperature-sensitive product even though nothing about the packaging looks wrong.`,
      );
    }
  }

  // 5. A later expected step exists without an earlier one — soft signal
  //    only, since real chains can legitimately have more hops than this
  //    three-step model assumes.
  const roles = ['manufacturer',...cps.map((c) => c.role.toLowerCase()),];
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

/**
 * Cross-batch checks: patterns only visible when looking at *multiple*
 * batches from the same manufacturer together, which a per-batch check
 * (including `analyzeChain` above) can never see by construction. Run
 * before, and independently of, the cross-batch AI prompt for the same
 * "never go blank on bad wifi" reason as the single-batch rules.
 */
export function analyzeCrossBatch(batches: BatchRecord[]): string[] {
  const findings: string[] = [];
  if (batches.length < 2) {
    findings.push('Only one batch found for this manufacturer — nothing to compare across yet.');
    return findings;
  }

  // 1. The same actor address recording checkpoints across many distinct
  //    batches in a short window — could be a legitimate high-volume
  //    distributor, or could be one compromised/complicit address rubber-
  //    stamping custody for a run of counterfeit batches.
  const actorTimestamps = new Map<string, { batchCode: string; ts: number }[]>();
  for (const b of batches) {
    for (const cp of b.checkpoints) {
      actorTimestamps.set(cp.actor, [
        ...(actorTimestamps.get(cp.actor) ?? []),
        { batchCode: b.batchCode, ts: cp.timestampMs },
      ]);
    }
  }
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  for (const [actor, entries] of actorTimestamps) {
    const distinctBatches = new Set(entries.map((e) => e.batchCode));
    if (distinctBatches.size < 3) continue;
    const sorted = [...entries].sort((a, b) => a.ts - b.ts);
    const span = sorted[sorted.length - 1].ts - sorted[0].ts;
    if (span <= ONE_DAY_MS) {
      findings.push(
        `Address ${actor} recorded checkpoints on ${distinctBatches.size} different batches (${[...distinctBatches].join(', ')}) within a single day — unusually concentrated for one actor.`,
      );
    }
  }

  // 2. A manufacturer with more than one batch that has ever had a
  //    Critical + Counterfeit hold — a single incident can be bad luck; a
  //    pattern across batches is a much stronger signal.
  const counterfeitBatches = batches.filter((b) =>
    b.holdHistory.some((h) => h.severity === 3 && h.category === 1),
  );
  if (counterfeitBatches.length >= 2) {
    findings.push(
      `${counterfeitBatches.length} batches from this manufacturer have each had a Critical + Counterfeit hold at some point (${counterfeitBatches.map((b) => b.batchCode).join(', ')}) — a repeat pattern, not an isolated incident.`,
    );
  }

  // 3. Multiple batches currently held at the same time.
  const currentlyHeld = batches.filter((b) => b.isHeld);
  if (currentlyHeld.length >= 2) {
    findings.push(
      `${currentlyHeld.length} batches from this manufacturer are on hold right now simultaneously (${currentlyHeld.map((b) => b.batchCode).join(', ')}).`,
    );
  }

  if (findings.length === 0) {
    findings.push(`No cross-batch pattern found across ${batches.length} batches from this manufacturer.`);
  }

  return findings;
}
