import { useState, type FormEvent } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { QrCodeCard } from './QrCodeCard';
import { ItemQrSheet } from './ItemQrSheet';

interface CreatedObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

export function RegisterBatchForm() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();

  const [batchCode, setBatchCode] = useState('');
  const [productName, setProductName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdBatchId, setCreatedBatchId] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!batchCode.trim() || !productName.trim()) {
      setError('Batch code and product name are both required.');
      return;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('create_batch'),
      arguments: [
        tx.pure.string(batchCode.trim()),
        tx.pure.string(productName.trim()),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: (result) => {
          const changes = (result.objectChanges ?? []) as CreatedObjectChange[];
          const created = changes.find(
            (change) => change.type === 'created' && change.objectType?.includes('::batch::Batch'),
          );
          if (created?.objectId) {
            setCreatedBatchId(created.objectId);
          } else {
            setError(
              'Batch was created, but the new object ID could not be read from the result. Check the browser console for the full transaction response.',
            );
            console.log('Transaction result:', result);
          }
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  const verifyUrl = createdBatchId
    ? `${window.location.origin}${window.location.pathname}?batch=${createdBatchId}`
    : null;

  return (
    <section className="panel">
      <h2>Register a new batch</h2>
      <p className="panel-intro">
        Called once by the manufacturer. This creates a shared object on Sui that every later
        checkpoint — distributor, pharmacy, and so on — will attach to.
      </p>

      {!account && <p className="error-text">Connect a wallet to register a batch.</p>}
      {error && <p className="error-text">{error}</p>}

      <form onSubmit={handleSubmit}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="batchCode">Batch code</label>
            <input
              id="batchCode"
              value={batchCode}
              onChange={(e) => setBatchCode(e.target.value)}
              placeholder="e.g. AMX-2026-0417"
              disabled={!account || isPending}
            />
          </div>
          <div className="field">
            <label htmlFor="productName">Product name</label>
            <input
              id="productName"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="e.g. Amoxicillin 500mg"
              disabled={!account || isPending}
            />
          </div>
        </div>

        <button type="submit" className="btn btn-primary" disabled={!account || isPending}>
          {isPending ? 'Registering on-chain…' : 'Register batch'}
        </button>
      </form>

      {createdBatchId && verifyUrl && (
        <div style={{ marginTop: 24 }}>
          <p className="success-banner">Batch registered. Print this QR code onto the physical packaging.</p>
          <QrCodeCard
            value={verifyUrl}
            label="Scan to verify this batch"
            helper="Anyone who scans this code lands on the public verification page for this exact batch."
          />
          <ItemQrSheet batchId={createdBatchId} batchCode={batchCode.trim()} />
        </div>
      )}
    </section>
  );
}
