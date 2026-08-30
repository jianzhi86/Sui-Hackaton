import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { RegisterBatchForm } from './components/RegisterBatchForm';
import { CheckpointScanner } from './components/CheckpointScanner';
import { BatchLookup } from './components/BatchLookup';
import { MintUnitForm } from './components/MintUnitForm';
import { PurchaseUnitScanner } from './components/PurchaseUnitScanner';
import { ActiveHoldsDashboard } from './components/ActiveHoldsDashboard';
import { StatsDashboard } from './components/StatsDashboard';

export type Tab = 'register' | 'scan' | 'verify' | 'mint' | 'pay' | 'holds' | 'stats';

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
      {tab === 'scan' && <CheckpointScanner />}
      {tab === 'verify' && <BatchLookup initialBatchId={initialBatchId} initialSerial={initialSerial} />}
      {tab === 'mint' && <MintUnitForm />}
      {tab === 'pay' && <PurchaseUnitScanner initialUnitId={initialUnitId} />}
      {tab === 'holds' && <ActiveHoldsDashboard onSelectBatch={handleSelectBatchFromHolds} />}
      {tab === 'stats' && <StatsDashboard />}
    </div>
  );
}
