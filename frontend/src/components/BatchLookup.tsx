import { useEffect, useState, type FormEvent } from 'react';
import { useSuiClientQuery } from '@mysten/dapp-kit';
import { parseBatchObject } from '../lib/suiRead';
import type { AnomalyReportResult, BatchRecord } from '../lib/types';
import { checkAnomaly } from '../lib/gonka';
import { QrScanButton } from './QrScanButton';
import { extractBatchId } from '../lib/qr';
import { AnomalyPanel } from './AnomalyPanel';
import { HoldControl } from './HoldControl';

interface BatchLookupProps {
  initialBatchId?: string;
}

export function BatchLookup({ initialBatchId }: BatchLookupProps) {
  const [batchId, setBatchId] = useState(initialBatchId ?? '');
  const [queryId, setQueryId] = useState(initialBatchId ?? '');
  const [report, setReport] = useState<AnomalyReportResult | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (initialBatchId) {
      setBatchId(initialBatchId);
      setQueryId(initialBatchId);
    }
  }, [initialBatchId]);

  const { data, isLoading, isFetched, isError, error, refetch } = useSuiClientQuery(
    'getObject',
    { id: queryId, options: { showContent: true } },
    { enabled: Boolean(queryId) },
  );

  const batch: BatchRecord | null = data ? parseBatchObject(data) : null;

  function handleLookup(e: FormEvent) {
    e.preventDefault();
    setReport(null);
    setQueryId(batchId.trim());
  }

  async function handleCheckAnomaly() {
    if (!batch) return;
    setChecking(true);
    try {
      const result = await checkAnomaly(batch);
      setReport(result);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="panel">
      <h2>Verify a product</h2>
      <p className="panel-intro">
        Paste a batch object ID, or scan the QR code on the packaging. This reads straight
        from Sui — no wallet or login required to check a product.
      </p>

      <QrScanButton onDecoded={(text) => setBatchId(extractBatchId(text))} />

      <form onSubmit={handleLookup}>
        <div className="field">
          <label htmlFor="lookupId">Batch object ID</label>
          <input
            id="lookupId"
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            placeholder="0x…"
          />
        </div>
        <button type="submit" className="btn btn-primary">
          Look up
        </button>
      </form>

      {isLoading && queryId && <p className="helper-text">Reading from Sui…</p>}
      {isError && (
        <p className="error-text">
          Could not read that object.{' '}
          {error instanceof Error ? error.message : 'Check the ID and try again.'}
        </p>
      )}
      {isFetched && !isLoading && !isError && !batch && queryId && (
        <p className="error-text">
          No batch found at that ID. This exact serial does not exist on-chain — treat the
          product as unverified and do not use it.
        </p>
      )}

      {batch && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: 2 }}>{batch.productName}</h3>
          <p className="helper-text">
            Batch <span className="code-chip">{batch.batchCode}</span> · registered by{' '}
            <span className="code-chip">{batch.manufacturer}</span>
          </p>

          <HoldControl batch={batch} onChanged={() => refetch()} />

          <div className="ledger">
            <div className="ledger-entry">
              <span className="ledger-dot">0</span>
              <div className="ledger-role">Manufactured</div>
              <div className="ledger-meta">{new Date(batch.createdAtMs).toLocaleString()}</div>
            </div>
            {batch.checkpoints.map((cp, i) => (
              <div className="ledger-entry" key={i}>
                <span className="ledger-dot">{i + 1}</span>
                <div className="ledger-role">{cp.role}</div>
                <div className="ledger-meta">
                  {cp.location} · {new Date(cp.timestampMs).toLocaleString()}
                </div>
                {cp.note && <div className="ledger-note">{cp.note}</div>}
                <div className="helper-text">
                  Recorded by <span className="code-chip">{cp.actor}</span>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 16 }}
            onClick={handleCheckAnomaly}
            disabled={checking}
          >
            {checking ? 'Running AI verification…' : 'Run AI verification'}
          </button>

          {report && <AnomalyPanel report={report} />}
        </div>
      )}
    </section>
  );
}
