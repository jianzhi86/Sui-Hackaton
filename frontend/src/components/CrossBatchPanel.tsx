import { useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from '../lib/network';
import { fetchAllEvents } from '../lib/activeHolds';
import { parseBatchObject } from '../lib/suiRead';
import { checkCrossBatchAnomaly } from '../lib/gonka';
import { AnomalyPanel } from './AnomalyPanel';
import { useToast } from '../lib/toast';
import type { AnomalyReportResult, BatchRecord } from '../lib/types';

interface CrossBatchPanelProps {
  batch: BatchRecord;
}

/**
 * Sui's JSON-RPC caps a single `multiGetObjects` call at 50 object IDs —
 * without chunking, a manufacturer with more than 50 registered batches
 * would silently only ever get compared against the first 50 `queryEvents`
 * happened to return. Fetches every chunk in parallel rather than one at a
 * time, since there's no cursor/ordering dependency between them.
 */
const MULTI_GET_OBJECTS_CHUNK_SIZE = 50;

async function multiGetObjectsChunked(
  client: ReturnType<typeof useSuiClient>,
  ids: string[],
): Promise<unknown[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += MULTI_GET_OBJECTS_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + MULTI_GET_OBJECTS_CHUNK_SIZE));
  }
  const results = await Promise.all(
    chunks.map((chunk) => client.multiGetObjects({ ids: chunk, options: { showContent: true } })),
  );
  return results.flat();
}

/**
 * Reasons across *every* batch from this manufacturer at once, not just
 * the one currently open — the point being that some counterfeiting
 * patterns (one compromised distributor touching many batches, a
 * manufacturer with repeated counterfeit findings) are only visible when
 * comparing batches against each other, and are invisible to a check
 * scoped to a single batch by construction.
 */
export function CrossBatchPanel({ batch }: CrossBatchPanelProps) {
  const client = useSuiClient();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [siblingCount, setSiblingCount] = useState<number | null>(null);
  const [report, setReport] = useState<AnomalyReportResult | null>(null);

  async function handleCheck() {
    setChecking(true);
    setReport(null);
    try {
      const createdEvents = await fetchAllEvents(client, `${PACKAGE_ID}::batch::BatchCreated`);
      const siblingIds = createdEvents
        .map((e) => {
          const pj = (e?.parsedJson ?? {}) as Record<string, unknown>;
          return { batchId: String(pj.batch_id ?? ''), manufacturer: String(pj.manufacturer ?? '') };
        })
        .filter((e) => e.manufacturer === batch.manufacturer && e.batchId)
        .map((e) => e.batchId);

      const uniqueIds = [...new Set(siblingIds)];
      const objects = await multiGetObjectsChunked(client, uniqueIds);
      const batches = objects
        .map((o) => parseBatchObject(o))
        .filter((b): b is BatchRecord => b !== null);

      setSiblingCount(batches.length);
      const result = await checkCrossBatchAnomaly(batches);
      setReport(result);
      if (result.models.length === 0) {
        toast.error('Gonka Router was unreachable — showing rule-based findings only.');
      } else {
        toast.success('Cross-batch check complete.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cross-batch check failed.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <button type="button" className="btn btn-secondary" onClick={handleCheck} disabled={checking}>
        {checking ? 'Comparing across batches…' : "Check this manufacturer's other batches"}
      </button>
      <p className="helper-text" style={{ marginTop: 4 }}>
        Reasons across every batch from the same manufacturer address, however many there are —
        catches patterns (one actor touching many batches, repeated counterfeit findings)
        invisible to a single-batch check.
      </p>
      {siblingCount !== null && (
        <p className="helper-text">Compared {siblingCount} batch(es) from this manufacturer.</p>
      )}
      {report && <AnomalyPanel report={report} />}
    </div>
  );
}
