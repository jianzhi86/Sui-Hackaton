import { useState, type FormEvent } from 'react';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { parseBatchObject } from '../lib/suiRead';
import { useToast } from '../lib/toast';
import { friendlyMoveError } from '../lib/moveErrors';
import { generateSecret, sha256Bytes } from '../lib/secret';
import { QrCodeCard } from './QrCodeCard';
import { CodeChip } from './CodeChip';
import { ConnectWalletBanner } from './ConnectWalletBanner';
import { usePersistedState, LAST_BATCH_ID_KEY } from '../lib/persisted';
import { mistPreview } from '../lib/formatSui';

interface CreatedObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

export function MintUnitForm() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();

  const [batchId, setBatchId] = usePersistedState(LAST_BATCH_ID_KEY, '');
  const [priceSui, setPriceSui] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdUnitId, setCreatedUnitId] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  // Checked purely so the form can warn before a doomed transaction —
  // `mint_unit` re-checks `is_held` on-chain regardless, so this is UX,
  // not the actual safety boundary.
  const { data: batchData } = useSuiClientQuery(
    'getObject',
    { id: batchId.trim(), options: { showContent: true } },
    { enabled: Boolean(batchId.trim()) },
  );
  const batch = batchData ? parseBatchObject(batchData) : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreatedUnitId(null);
    setCreatedSecret(null);

    const priceNum = Number(priceSui);
    if (!batchId.trim()) {
      setError('Batch object ID is required.');
      return;
    }
    if (batch?.isHeld) {
      setError('This batch is on hold — sale QRs can\'t be minted until the hold is released.');
      return;
    }
    if (batch && batch.expiryMs <= Date.now()) {
      setError('This batch has expired — sale QRs can\'t be minted for it anymore.');
      return;
    }
    if (!priceSui.trim() || !Number.isFinite(priceNum) || priceNum <= 0) {
      setError('Price must be a positive number of SUI.');
      return;
    }

    const priceMist = BigInt(Math.round(priceNum * Number(MIST_PER_SUI)));

    // The secret never touches the visible QR — it's generated here,
    // hashed for the on-chain call, and shown separately below for the
    // pharmacist to hand to the buyer through a different channel.
    const secret = generateSecret();
    const secretHashBytes = await sha256Bytes(secret);

    const tx = new Transaction();
    tx.moveCall({
      target: target('mint_unit'),
      arguments: [
        tx.object(batchId.trim()),
        tx.pure.u64(priceMist),
        tx.pure.vector('u8', secretHashBytes),
        tx.object(CLOCK_OBJECT_ID),
      ],
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
            setCreatedSecret(secret);
            toast.success('Sale QR minted.');
          } else {
            setError(
              'Unit was minted, but the new object ID could not be read from the result. Check the browser console for the full transaction response.',
            );
            console.log('Transaction result:', result);
          }
        },
        onError: (err) => toast.error(friendlyMoveError(err.message)),
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
        Any connected wallet can do this — "pharmacy" is simply whoever signs this transaction, not
        a vetted claim. Generate this at the register, right as the customer is checking out — it
        expires 10 minutes after minting, so don't pre-print it onto packaging or show it to anyone
        before they're ready to pay. It also comes with a one-time scratch code that must be given
        to the buyer separately from the QR — the QR alone (just an object ID) can be photographed
        and cloned like any barcode, but a clone without the matching code can't be redeemed.
      </p>

      {!account && <ConnectWalletBanner action="mint a sale QR" />}
      {error && <p className="error-text">{error}</p>}
      {batch?.isHeld && (
        <p className="error-text">
          🚫 This batch is currently on hold ({batch.holdReason || 'no reason given'}) — minting is
          blocked on-chain until the hold is released.
        </p>
      )}
      {batch && !batch.isHeld && batch.expiryMs <= Date.now() && (
        <p className="error-text">
          🚫 This batch expired on {new Date(batch.expiryMs).toLocaleDateString()} — minting is
          blocked on-chain for expired batches.
        </p>
      )}

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
            {Number(priceSui) > 0 && (
              <span className="helper-text" style={{ fontFamily: 'var(--font-mono)' }}>
                {mistPreview(Number(priceSui))}
              </span>
            )}
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            !account ||
            isPending ||
            Boolean(batch?.isHeld) ||
            Boolean(batch && batch.expiryMs <= Date.now())
          }
        >
          {isPending ? 'Minting on-chain…' : 'Mint single-use QR'}
        </button>
      </form>

      {createdUnitId && payUrl && createdSecret && (
        <div style={{ marginTop: 24 }}>
          <p className="success-banner">
            Sale QR created for {priceSui} SUI, expiring in 10 minutes. Show the QR to the
            customer to scan, then tell/write them the scratch code below <strong>separately</strong>{' '}
            — do not show both together where a third party could photograph both at once. The QR
            alone cannot be redeemed without this code.
          </p>
          <QrCodeCard
            value={payUrl}
            label="Scan to pay & dispense"
            helper="Redeemable exactly once, within 10 minutes, and only with the matching scratch code. After payment (or expiry), this QR stops working for everyone, including the buyer who just used it."
          />
          <div className="qr-card" style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Scratch code — give to buyer separately, not with the QR
            </div>
            <CodeChip value={createdSecret} />
          </div>
        </div>
      )}
    </section>
  );
}
