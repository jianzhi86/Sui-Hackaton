import { useState, type FormEvent } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import {
  ADMIN_REGISTRY_OBJECT_ID,
  CLOCK_OBJECT_ID,
  DEFAULT_NETWORK,
  MANUFACTURER_REGISTRY_OBJECT_ID,
  target,
} from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { useIsListed } from '../lib/registry';
import { useToast } from '../lib/toast';
import { QrCodeCard } from './QrCodeCard';
import { ItemQrSheet } from './ItemQrSheet';
import { CodeChip } from './CodeChip';
import { RegistryAdminPanel } from './RegistryAdminPanel';
import { AdminRegistryPanel } from './AdminRegistryPanel';
import { explorerTxUrl } from '../lib/explorer';

interface CreatedObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

/** Default expiry offset for the date input: two years out, a reasonable
 * pharma shelf-life default the manufacturer can override. */
const DEFAULT_EXPIRY_DAYS = 730;

function defaultExpiryDateInput(): string {
  const d = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function RegisterBatchForm() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();
  const { isListed: isManufacturer, isLoading: manuLoading } = useIsListed(
    MANUFACTURER_REGISTRY_OBJECT_ID,
    'manufacturers',
  );
  const { isListed: isAdmin, refetch: refetchAdmin } = useIsListed(ADMIN_REGISTRY_OBJECT_ID, 'admins');

  const [batchCode, setBatchCode] = useState('');
  const [productName, setProductName] = useState('');
  const [expiryDate, setExpiryDate] = useState(defaultExpiryDateInput());
  const [error, setError] = useState<string | null>(null);
  const [createdBatchId, setCreatedBatchId] = useState<string | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  const canAct = Boolean(account && isManufacturer && !manuLoading);

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

    const tx = new Transaction();
    tx.moveCall({
      target: target('create_batch'),
      arguments: [
        tx.object(MANUFACTURER_REGISTRY_OBJECT_ID),
        tx.pure.string(batchCode.trim()),
        tx.pure.string(productName.trim()),
        tx.pure.u64(expiryMs),
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

  const verifyUrl = createdBatchId
    ? `${window.location.origin}${window.location.pathname}?batch=${createdBatchId}`
    : null;

  return (
    <section className="panel">
      <h2>Register a new batch</h2>
      <p className="panel-intro">
        Called once by the manufacturer. This creates a shared object on Sui that every later
        checkpoint — distributor, pharmacy, and so on — will attach to. Only addresses listed in
        the manufacturer registry can do this — otherwise "manufacturer" would just be a
        self-declared label anyone could type.
      </p>

      {!account && <p className="error-text">Connect a wallet to register a batch.</p>}
      {error && <p className="error-text">{error}</p>}
      {account && !manuLoading && !isManufacturer && (
        <p className="error-text">
          Your connected wallet is not a listed manufacturer, so it cannot register a batch. Ask
          an admin to add your address to the manufacturer registry.
        </p>
      )}

      <form onSubmit={handleSubmit}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="batchCode">Batch code</label>
            <input
              id="batchCode"
              value={batchCode}
              onChange={(e) => setBatchCode(e.target.value)}
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

        <div className="field">
          <label htmlFor="expiryDate">Expiry date</label>
          <input
            id="expiryDate"
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            disabled={!canAct || isPending}
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={!canAct || isPending}>
          {isPending ? 'Registering on-chain…' : 'Register batch'}
        </button>
      </form>

      {isAdmin && (
        <RegistryAdminPanel
          adminRegistryId={ADMIN_REGISTRY_OBJECT_ID}
          registryObjectId={MANUFACTURER_REGISTRY_OBJECT_ID}
          addFn="admin_add_manufacturer"
          revokeFn="admin_revoke_manufacturer"
          roleLabel="manufacturer"
          onChanged={refetchAdmin}
        />
      )}
      {isAdmin && <AdminRegistryPanel onChanged={refetchAdmin} />}

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
        </div>
      )}
    </section>
  );
}
