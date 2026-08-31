import { Suspense, lazy, useEffect, useState } from 'react';
import { Header } from './components/Header';
import { RegisterBatchForm } from './components/RegisterBatchForm';

// Code-split every tab except the default ("register") one — each pulls
// in dependencies (html5-qrcode for scanning, the Gonka/cross-batch AI
// logic, the Stats/Active-Holds event aggregation) that only matter once
// someone actually opens that tab, so there's no reason to ship them in
// the initial bundle every visitor downloads regardless of which tab (if
// any) they end up using.
const CheckpointScanner = lazy(() =>
  import('./components/CheckpointScanner').then((m) => ({ default: m.CheckpointScanner })),
);
const BatchLookup = lazy(() => import('./components/BatchLookup').then((m) => ({ default: m.BatchLookup })));
const MintUnitForm = lazy(() => import('./components/MintUnitForm').then((m) => ({ default: m.MintUnitForm })));
const PurchaseUnitScanner = lazy(() =>
  import('./components/PurchaseUnitScanner').then((m) => ({ default: m.PurchaseUnitScanner })),
);
const ActiveHoldsDashboard = lazy(() =>
  import('./components/ActiveHoldsDashboard').then((m) => ({ default: m.ActiveHoldsDashboard })),
);
const StatsDashboard = lazy(() => import('./components/StatsDashboard').then((m) => ({ default: m.StatsDashboard })));

export type Tab = 'register' | 'scan' | 'verify' | 'mint' | 'pay' | 'holds' | 'stats';

function TabFallback() {
  return (
    <section className="panel">
      <p className="helper-text">Loading…</p>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('register');
  const [initialBatchId, setInitialBatchId] = useState<string | undefined>(undefined);
  const [initialSerial, setInitialSerial] = useState<string | undefined>(undefined);
  const [initialUnitId, setInitialUnitId] = useState<string | undefined>(undefined);

  // A scanned "final" QR code encodes `?batch=<objectId>` (optionally with
  // `&serial=<n>` for a per-package verify label) — land directly on the
  // public verify tab with that batch pre-loaded, no extra taps needed.
  // A single-use sale QR instead encodes `?unit=<objectId>` and lands on the
  // pay tab so a customer can scan-and-pay in one motion.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('batch');
    const serialFromUrl = params.get('serial');
    const unitFromUrl = params.get('unit');
    if (unitFromUrl) {
      setInitialUnitId(unitFromUrl);
      setTab('pay');
    } else if (fromUrl) {
      setInitialBatchId(fromUrl);
      setInitialSerial(serialFromUrl ?? undefined);
      setTab('verify');
    }
  }, []);

  function handleSelectBatchFromHolds(batchId: string) {
    setInitialBatchId(batchId);
    setInitialSerial(undefined);
    setTab('verify');
  }

  return (
    <div className="app-shell">
      <Header active={tab} onNavigate={setTab} />
      {tab === 'register' && <RegisterBatchForm />}
      <Suspense fallback={<TabFallback />}>
        {tab === 'scan' && <CheckpointScanner />}
        {tab === 'verify' && <BatchLookup initialBatchId={initialBatchId} initialSerial={initialSerial} />}
        {tab === 'mint' && <MintUnitForm />}
        {tab === 'pay' && <PurchaseUnitScanner initialUnitId={initialUnitId} />}
        {tab === 'holds' && <ActiveHoldsDashboard onSelectBatch={handleSelectBatchFromHolds} />}
        {tab === 'stats' && <StatsDashboard />}
      </Suspense>
    </div>
  );
}
