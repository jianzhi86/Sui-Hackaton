import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { RegisterBatchForm } from './components/RegisterBatchForm';
import { CheckpointScanner } from './components/CheckpointScanner';
import { BatchLookup } from './components/BatchLookup';

export type Tab = 'register' | 'scan' | 'verify';

export default function App() {
  const [tab, setTab] = useState<Tab>('register');
  const [initialBatchId, setInitialBatchId] = useState<string | undefined>(undefined);

  // A scanned "final" QR code encodes `?batch=<objectId>` — land directly on
  // the public verify tab with that batch pre-loaded, no extra taps needed.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('batch');
    if (fromUrl) {
      setInitialBatchId(fromUrl);
      setTab('verify');
    }
  }, []);

  return (
    <div className="app-shell">
      <Header active={tab} onNavigate={setTab} />
      {tab === 'register' && <RegisterBatchForm />}
      {tab === 'scan' && <CheckpointScanner />}
      {tab === 'verify' && <BatchLookup initialBatchId={initialBatchId} />}
    </div>
  );
}
