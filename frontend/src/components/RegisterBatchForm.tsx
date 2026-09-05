import { useState, type FormEvent } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useToast } from '../lib/toast';
import { QrCodeCard } from './QrCodeCard';
import { ItemQrSheet } from './ItemQrSheet';
import { CodeChip } from './CodeChip';
import { ConnectWalletBanner } from './ConnectWalletBanner';
import { MyBatchesPanel } from './MyBatchesPanel';
import { explorerTxUrl } from '../lib/explorer';
import { mistPreview } from '../lib/formatSui';

interface CreatedObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

interface RegisterBatchFormProps {
  onSelectBatch: (batchId: string) => void;
}

/** Default expiry offset for the date input: two years out, a reasonable
 * pharma shelf-life default the manufacturer can override. */
const DEFAULT_EXPIRY_DAYS = 730;

function defaultExpiryDateInput(): string {
  const d = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10);
}

export function RegisterBatchForm({ onSelectBatch }: RegisterBatchFormProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();

  const [batchCode, setBatchCode] = useState('');
  const [productName, setProductName] = useState('');
  const [expiryDate, setExpiryDate] = useState(defaultExpiryDateInput());
  const [stakeSui, setStakeSui] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [createdBatchId, setCreatedBatchId] = useState<string | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  const canAct = Boolean(account);
  const canSubmit = canAct && Boolean(batchCode.trim()) && Boolean(productName.trim());

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!batchCode.trim() || !productName.trim()) {
      setError('Batch code and product name are both required.');
      return;
    }

    const expiryMs = new Date(expiryDate).getTime();
    if (!expiryDate || Number.isNaN(expiryMs) || expiryMs <= Date.now()) {
      setError('Expiry date must be a valid date in the future.');
      return;
    }

    const stakeSuiNum = Number(stakeSui);
    if (!stakeSui.trim() || !Number.isFinite(stakeSuiNum) || stakeSuiNum < 0) {
      setError('Stake amount must be zero or a positive number of SUI.');
      return;
    }
    const stakeMist = BigInt(Math.round(stakeSuiNum * Number(MIST_PER_SUI)));

    if (
      stakeSuiNum > 0 &&
      !window.confirm(
        `Lock ${stakeSuiNum} SUI as stake for this batch? It stays locked until expiry and can be partly or fully slashed if a hold is later placed on this batch.`,
      )
    ) {
      return;
    }

    const tx = new Transaction();
    const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeMist)]);
    tx.moveCall({
      target: target('create_batch'),
      arguments: [
        tx.pure.string(batchCode.trim()),
        tx.pure.string(productName.trim()),
        tx.pure.u64(expiryMs),
        stakeCoin,
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
            setLastDigest(result.digest);
            setStakeSui('0');
            toast.success('Batch registered.');
          } else {
            setError(
              'Batch was created, but the new object ID could not be read from the result. Check the browser console for the full transaction response.',
            );
            console.log('Transaction result:', result);
          }
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleRegisterAnother() {
    setBatchCode('');
    setProductName('');
    setExpiryDate(defaultExpiryDateInput());
    setCreatedBatchId(null);
    setLastDigest(null);
    setError(null);
  }

  const verifyUrl = createdBatchId
    ? `${window.location.origin}${window.location.pathname}?batch=${createdBatchId}`
    : null;

  return (
    <section className="panel">
      <h2>Register a new batch</h2>
      <p className="panel-intro">
        Called once by the manufacturer. This creates a shared object on Sui that every later
        checkpoint — distributor, pharmacy, and so on — will attach to. Any connected wallet can
        register a batch; "manufacturer" is simply whoever signs this transaction, not a vetted
        claim (see the README for the tradeoff).
      </p>

      {!account && <ConnectWalletBanner action="register a batch" />}
      {error && <p className="error-text">{error}</p>}

      <form onSubmit={handleSubmit}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="batchCode">Batch code</label>
            <input
              id="batchCode"
              value={batchCode}
              onChange={(e) => setBatchCode(e.target.value.toUpperCase())}
              placeholder="e.g. AMX-2026-0417"
              disabled={!canAct || isPending}
            />
          </div>
          <div className="field">
            <label htmlFor="productName">Product name</label>
            <input
              id="productName"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="e.g. Amoxicillin 500mg"
              disabled={!canAct || isPending}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="expiryDate">Expiry date</label>
            <input
              id="expiryDate"
              type="date"
              min={todayDateInput()}
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              disabled={!canAct || isPending}
            />
          </div>
          <div className="field">
            <label htmlFor="stakeSui">Stake (SUI, optional)</label>
            <input
              id="stakeSui"
              type="number"
              min="0"
              step="0.01"
              value={stakeSui}
              onChange={(e) => setStakeSui(e.target.value)}
              placeholder="0"
              disabled={!canAct || isPending}
            />
            {Number(stakeSui) > 0 && (
              <span className="helper-text" style={{ fontFamily: 'var(--font-mono)' }}>
                {mistPreview(Number(stakeSui))}
              </span>
            )}
          </div>
        </div>
        <p className="helper-text" style={{ marginTop: -8, marginBottom: 16 }}>
          Locked for this batch's whole shelf life. A hold placed on it later can slash some or
          all of the stake to whoever placed the hold; otherwise you can withdraw it back once the
          batch expires. Leave at 0 to register without staking anything.
        </p>

        <button type="submit" className="btn btn-primary" disabled={!canSubmit || isPending}>
          {isPending ? 'Registering on-chain…' : 'Register batch'}
        </button>
      </form>

      {createdBatchId && verifyUrl && (
        <div style={{ marginTop: 24 }}>
          <p className="success-banner">
            Batch registered — <CodeChip value={createdBatchId} /> (expires {expiryDate}).
            {lastDigest && (
              <>
                {' '}
                Transaction: <CodeChip value={lastDigest} href={explorerTxUrl(lastDigest)} title="View on Sui Explorer" />
              </>
            )}
            {' '}Print this QR code onto the physical packaging.
          </p>
          <QrCodeCard
            value={verifyUrl}
            label="Scan to verify this batch"
            helper="Anyone who scans this code lands on the public verification page for this exact batch."
          />
          <ItemQrSheet batchId={createdBatchId} batchCode={batchCode.trim()} />
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 16 }}
            onClick={handleRegisterAnother}
          >
            Register another batch
          </button>
        </div>
      )}

      <MyBatchesPanel onSelectBatch={onSelectBatch} />
    </section>
  );
}
