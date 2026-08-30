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
import { CodeChip } from './CodeChip';
import { explorerAddressUrl } from '../lib/explorer';
import { useToast } from '../lib/toast';
import { COLD_CHAIN_MAX_C, COLD_CHAIN_MIN_C } from '../lib/chainAnalysis';

/** How far ahead of expiry the UI starts warning — 60 days, a reasonable
 * pharma "reorder before this runs out" window. Purely a UI nudge; the
 * actual sale-blocking check happens on-chain at the exact expiry_ms. */
const NEAR_EXPIRY_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

interface BatchLookupProps {
  initialBatchId?: string;
  initialSerial?: string;
}

export function BatchLookup({ initialBatchId, initialSerial }: BatchLookupProps) {
  const toast = useToast();
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
    {
      enabled: Boolean(queryId),
      // Without this, revisiting the same batch ID (e.g. switching back
      // from the Scan tab after adding a checkpoint elsewhere) can show a
      // cached snapshot from before that checkpoint existed — looking like
      // "this wasn't recorded" when it actually was, just not refetched.
      staleTime: 0,
      refetchOnMount: 'always',
    },
  );

  const batch: BatchRecord | null = data ? parseBatchObject(data) : null;

  // An AI report reasons over a specific snapshot of the checkpoint/hold
  // state. If that state changes underneath it (a new checkpoint lands, a
  // hold gets placed/released) after the report was generated, the old
  // report's conclusions no longer describe the current batch — clear it
  // rather than let a stale "no checkpoints yet" verdict sit next to a
  // ledger that now has one.
  const batchFingerprint = batch
    ? `${batch.checkpoints.length}:${batch.isHeld}:${batch.holdHistory.length}`
    : null;
  const [lastReportFingerprint, setLastReportFingerprint] = useState<string | null>(null);
  const [reportInvalidated, setReportInvalidated] = useState(false);
  useEffect(() => {
    if (report && batchFingerprint !== null && batchFingerprint !== lastReportFingerprint) {
      setReport(null);
      setReportInvalidated(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchFingerprint]);

  function handleLookup(e: FormEvent) {
    e.preventDefault();
    setReport(null);
    setReportInvalidated(false);
    setSerial(null);
    setQueryId(batchId.trim());
  }

  async function handleCheckAnomaly() {
    if (!batch) return;
    setChecking(true);
    try {
      const result = await checkAnomaly(batch);
      setReport(result);
      setLastReportFingerprint(batchFingerprint);
      setReportInvalidated(false);
      if (result.models.length === 0) {
        toast.error('Gonka Router was unreachable — showing rule-based findings only.');
      } else {
        toast.success('AI verification complete.');
      }
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
            · registered by <CodeChip value={batch.manufacturer} href={explorerAddressUrl(batch.manufacturer)} /> ·
            expires {new Date(batch.expiryMs).toLocaleDateString()}
          </p>

          {batch.expiryMs <= Date.now() ? (
            <p className="error-text">
              🚫 This batch expired on {new Date(batch.expiryMs).toLocaleDateString()} — sale QRs
              can no longer be minted or redeemed for it.
            </p>
          ) : batch.expiryMs - Date.now() <= NEAR_EXPIRY_WINDOW_MS ? (
            <p className="helper-text" style={{ color: 'var(--flag-amber)' }}>
              ⚠ Expires soon — {new Date(batch.expiryMs).toLocaleDateString()}.
            </p>
          ) : null}

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
                {cp.temperatureC !== null && (
                  <div
                    className="helper-text"
                    style={
                      cp.temperatureC < COLD_CHAIN_MIN_C || cp.temperatureC > COLD_CHAIN_MAX_C
                        ? { color: 'var(--danger)' }
                        : undefined
                    }
                  >
                    🌡 {cp.temperatureC}°C
                    {(cp.temperatureC < COLD_CHAIN_MIN_C || cp.temperatureC > COLD_CHAIN_MAX_C) &&
                      ` — outside ${COLD_CHAIN_MIN_C}-${COLD_CHAIN_MAX_C}°C cold-chain range`}
                  </div>
                )}
                <div className="helper-text">
                  Recorded by <CodeChip value={cp.actor} href={explorerAddressUrl(cp.actor)} />
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
          {!checking && reportInvalidated && (
            <p className="helper-text" style={{ marginTop: 4 }}>
              The custody chain changed since the last check (a checkpoint or hold was
              added/updated) — the previous report no longer reflects the current state and has
              been cleared. Re-run verification for a current result.
            </p>
          )}

          {report && <AnomalyPanel report={report} />}

          <ItemQrSheet batchId={batch.objectId} batchCode={batch.batchCode} />
        </div>
      )}
    </section>
  );
}
