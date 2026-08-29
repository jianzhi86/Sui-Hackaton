import { useEffect, useState, type FormEvent } from 'react';
import { useSuiClientQuery } from '@mysten/dapp-kit';
import { parseBatchObject } from '../lib/suiRead';
import type { AnomalyReportResult, BatchRecord } from '../lib/types';
import { checkAnomaly } from '../lib/gonka';
import { QrScanButton } from './QrScanButton';
import { extractBatchId, extractSerial } from '../lib/qr';
import { AnomalyPanel } from './AnomalyPanel';
import { HoldControl } from './HoldControl';
import { ItemQrSheet } from './ItemQrSheet';

interface BatchLookupProps {
  initialBatchId?: string;
  initialSerial?: string;
}

export function BatchLookup({ initialBatchId, initialSerial }: BatchLookupProps) {
  const [batchId, setBatchId] = useState(initialBatchId ?? '');
  const [queryId, setQueryId] = useState(initialBatchId ?? '');
  const [serial, setSerial] = useState<string | null>(initialSerial ?? null);
  const [report, setReport] = useState<AnomalyReportResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingElapsedS, setCheckingElapsedS] = useState(0);

  // Two independent models running with full reasoning genuinely takes
  // 20-40+ seconds — without this, "Running AI verification…" alone looks
  // frozen well before either model has answered.
  useEffect(() => {
    if (!checking) return;
    setCheckingElapsedS(0);
    const id = setInterval(() => setCheckingElapsedS((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [checking]);

  useEffect(() => {
    if (initialBatchId) {
      setBatchId(initialBatchId);
      setQueryId(initialBatchId);
      setSerial(initialSerial ?? null);
    }
  }, [initialBatchId, initialSerial]);

  const { data, isLoading, isFetched, isError, error, refetch } = useSuiClientQuery(
    'getObject',
    { id: queryId, options: { showContent: true } },
    { enabled: Boolean(queryId) },
  );

  const batch: BatchRecord | null = data ? parseBatchObject(data) : null;

  function handleLookup(e: FormEvent) {
    e.preventDefault();
    setReport(null);
    setSerial(null);
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

      <QrScanButton
        onDecoded={(text) => {
          setBatchId(extractBatchId(text));
          setSerial(extractSerial(text));
        }}
      />

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

      {batch && serial && batch.isHeld && (
        <div className="hold-banner hold-banner-active" style={{ marginTop: 20 }}>
          <strong style={{ fontSize: 16 }}>
            🚫 DO NOT USE THIS MEDICINE — package #{serial} belongs to a batch currently on hold
          </strong>
          <p style={{ marginBottom: 0 }}>
            Reason: "{batch.holdReason}". This applies to every package from batch{' '}
            <span className="code-chip">{batch.batchCode}</span>, including this specific one, even
            though it was printed and may already be with you — a hold placed after packaging still
            covers packages already out in the world. Do not take or dispense it; contact the
            pharmacy or manufacturer.
          </p>
        </div>
      )}

      {batch && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: 2 }}>{batch.productName}</h3>
          <p className="helper-text">
            Batch <span className="code-chip">{batch.batchCode}</span>
            {serial && (
              <>
                {' '}
                · package <span className="code-chip">#{serial}</span>
              </>
            )}{' '}
            · registered by <span className="code-chip">{batch.manufacturer}</span>
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
            {checking ? `Running AI verification… (${checkingElapsedS}s)` : 'Run AI verification'}
          </button>
          {checking && (
            <p className="helper-text" style={{ marginTop: 4 }}>
              Querying 2 independent models on Gonka Router in parallel — this genuinely takes
              20-40+ seconds with full reasoning, it isn't stuck.
            </p>
          )}

          {report && <AnomalyPanel report={report} />}

          <ItemQrSheet batchId={batch.objectId} batchCode={batch.batchCode} />
        </div>
      )}
    </section>
  );
}
