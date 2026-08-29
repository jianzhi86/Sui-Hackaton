import { useEffect, useState } from 'react';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, UNIT_EXPIRY_MS, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { parseUnitObject } from '../lib/suiRead';
import { extractUnitId } from '../lib/qr';
import { QrScanButton } from './QrScanButton';

interface PurchaseUnitScannerProps {
  initialUnitId?: string;
}

export function PurchaseUnitScanner({ initialUnitId }: PurchaseUnitScannerProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();

  const [unitId, setUnitId] = useState(initialUnitId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (initialUnitId) setUnitId(initialUnitId);
  }, [initialUnitId]);

  // Drives the countdown below — the actual expiry check that matters is
  // the one `purchase_and_burn` runs on-chain against the network clock;
  // this is just so the button doesn't invite a doomed transaction.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, isFetched, refetch } = useSuiClientQuery(
    'getObject',
    { id: unitId, options: { showContent: true } },
    { enabled: Boolean(unitId) },
  );

  const unit = data ? parseUnitObject(data) : null;
  const alreadyRedeemed = Boolean(unitId) && isFetched && !isLoading && !unit;

  function handlePay() {
    if (!unit) return;
    setError(null);
    setSuccess(null);

    const tx = new Transaction();
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(unit.price)]);
    tx.moveCall({
      target: target('purchase_and_burn'),
      arguments: [tx.object(unit.objectId), payment, tx.object(CLOCK_OBJECT_ID)],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: (result) => {
          setSuccess(
            `Payment sent, medicine dispensed. This QR is now burned — transaction digest: ${result.digest}`,
          );
          refetch();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  const priceSui = unit ? Number(unit.price) / Number(MIST_PER_SUI) : null;
  // Approximate: compares the on-chain mint timestamp against this device's
  // wall clock, which can drift slightly from the network's shared Clock.
  // Good enough to steer the UI; `purchase_and_burn` is the real gate.
  const remainingMs = unit ? unit.mintedAtMs + UNIT_EXPIRY_MS - now : null;
  const expired = remainingMs !== null && remainingMs <= 0;
  const remainingLabel =
    remainingMs !== null && remainingMs > 0
      ? `${Math.floor(remainingMs / 60000)}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')}`
      : null;

  return (
    <section className="panel">
      <h2>Pay & dispense</h2>
      <p className="panel-intro">
        Scan the single-use QR on the package, then pay directly from your wallet. Payment and
        redemption happen in the same transaction — the moment it confirms, this exact QR stops
        working for anyone, including you if you scan it again.
      </p>

      {!account && <p className="error-text">Connect a wallet to pay.</p>}
      {error && <p className="error-text">{error}</p>}
      {success && <p className="success-banner">{success}</p>}

      <QrScanButton onDecoded={(text) => setUnitId(extractUnitId(text))} />

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="unitId">Unit object ID</label>
        <input
          id="unitId"
          value={unitId}
          onChange={(e) => setUnitId(e.target.value)}
          placeholder="0x… (scan the sale QR, or paste manually)"
          disabled={isPending}
        />
      </div>

      {isLoading && unitId && <p className="helper-text">Checking this QR…</p>}

      {alreadyRedeemed && (
        <p className="error-text">
          This QR has already been paid for and burned (or the ID is wrong). It cannot be
          redeemed again — treat any medicine offered against it as unpaid/unverified.
        </p>
      )}

      {unit && !expired && (
        <div style={{ marginTop: 16 }}>
          <p className="helper-text">
            Price <span className="code-chip">{priceSui} SUI</span> · batch{' '}
            <span className="code-chip">{unit.batchId}</span> · expires in{' '}
            <span className="code-chip">{remainingLabel}</span>
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handlePay}
            disabled={!account || isPending}
          >
            {isPending ? 'Paying on-chain…' : `Pay ${priceSui} SUI & dispense`}
          </button>
        </div>
      )}

      {unit && expired && (
        <p className="error-text">
          This QR expired before it was paid for. Single-use sale QRs are only redeemable for a
          short window after being generated — ask the pharmacy to mint a fresh one.
        </p>
      )}
    </section>
  );
}
