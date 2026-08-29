import { useState, type FormEvent } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { QrCodeCard } from './QrCodeCard';

interface CreatedObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

export function MintUnitForm() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();

  const [batchId, setBatchId] = useState('');
  const [priceSui, setPriceSui] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdUnitId, setCreatedUnitId] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreatedUnitId(null);

    const priceNum = Number(priceSui);
    if (!batchId.trim()) {
      setError('Batch object ID is required.');
      return;
    }
    if (!priceSui.trim() || !Number.isFinite(priceNum) || priceNum <= 0) {
      setError('Price must be a positive number of SUI.');
      return;
    }

    const priceMist = BigInt(Math.round(priceNum * Number(MIST_PER_SUI)));

    const tx = new Transaction();
    tx.moveCall({
      target: target('mint_unit'),
      arguments: [tx.object(batchId.trim()), tx.pure.u64(priceMist), tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: (result) => {
          const changes = (result.objectChanges ?? []) as CreatedObjectChange[];
          const created = changes.find(
            (change) => change.type === 'created' && change.objectType?.includes('::batch::Unit'),
          );
          if (created?.objectId) {
            setCreatedUnitId(created.objectId);
          } else {
            setError(
              'Unit was minted, but the new object ID could not be read from the result. Check the browser console for the full transaction response.',
            );
            console.log('Transaction result:', result);
          }
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  const payUrl = createdUnitId
    ? `${window.location.origin}${window.location.pathname}?unit=${createdUnitId}`
    : null;

  return (
    <section className="panel">
      <h2>Create a single-use sale QR</h2>
      <p className="panel-intro">
        Mints one on-chain <span className="code-chip">Unit</span> tied to a batch, priced in SUI.
        Generate this at the register, right as the customer is checking out — it expires 10
        minutes after minting, so don't pre-print it onto packaging or show it to anyone before
        they're ready to pay. A photo of a code that's still sitting on a shelf is exactly what a
        counterfeiter would want to clone; a code that only exists for the length of one checkout
        gives them nothing to copy.
      </p>

      {!account && <p className="error-text">Connect a wallet to mint a sale QR.</p>}
      {error && <p className="error-text">{error}</p>}

      <form onSubmit={handleSubmit}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="unitBatchId">Batch object ID</label>
            <input
              id="unitBatchId"
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
              placeholder="0x… (from the batch's registration)"
              disabled={!account || isPending}
            />
          </div>
          <div className="field">
            <label htmlFor="price">Price (SUI)</label>
            <input
              id="price"
              type="number"
              min="0"
              step="0.01"
              value={priceSui}
              onChange={(e) => setPriceSui(e.target.value)}
              placeholder="e.g. 5"
              disabled={!account || isPending}
            />
          </div>
        </div>

        <button type="submit" className="btn btn-primary" disabled={!account || isPending}>
          {isPending ? 'Minting on-chain…' : 'Mint single-use QR'}
        </button>
      </form>

      {createdUnitId && payUrl && (
        <div style={{ marginTop: 24 }}>
          <p className="success-banner">
            Sale QR created for {priceSui} SUI, expiring in 10 minutes. Show it to the customer
            now — anyone who scans and pays it first gets the medicine, so keep the screen turned
            away from anyone else until they've paid.
          </p>
          <QrCodeCard
            value={payUrl}
            label="Scan to pay & dispense"
            helper="Redeemable exactly once, within 10 minutes. After payment (or after it expires unpaid), this QR stops working for everyone, including the buyer who just used it."
          />
        </div>
      )}
    </section>
  );
}
