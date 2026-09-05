import { useEffect, useState } from 'react';
import { useCurrentAccount, useSuiClientQuery } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { MIST_PER_SUI } from '@mysten/sui/utils';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, UNIT_EXPIRY_MS, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { parseBatchObject, parseUnitObject } from '../lib/suiRead';
import { extractUnitId } from '../lib/qr';
import { useToast } from '../lib/toast';
import { friendlyMoveError } from '../lib/moveErrors';
import { sha256Hex, utf8Bytes } from '../lib/secret';
import { CodeChip } from './CodeChip';
import { ConnectWalletBanner } from './ConnectWalletBanner';
import { explorerTxUrl } from '../lib/explorer';
import { QrScanButton } from './QrScanButton';
import { usePersistedState, LAST_UNIT_ID_KEY } from '../lib/persisted';

interface PurchaseUnitScannerProps {
  initialUnitId?: string;
}

export function PurchaseUnitScanner({ initialUnitId }: PurchaseUnitScannerProps) {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();

  const [unitId, setUnitId] = usePersistedState(LAST_UNIT_ID_KEY, initialUnitId ?? '');
  const [scratchCode, setScratchCode] = useState('');
  const [scratchCodeWrong, setScratchCodeWrong] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);
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

  const { data, isLoading, isFetched, isError: unitError, refetch } = useSuiClientQuery(
    'getObject',
    { id: unitId, options: { showContent: true } },
    { enabled: Boolean(unitId) },
  );

  const unit = data ? parseUnitObject(data) : null;
  const unitUnavailable = Boolean(unitId) && isFetched && !isLoading && !unitError && !unit;
  useEffect(() => {
    setScratchCode('');
    setScratchCodeWrong(false);
    setLastDigest(null);
    setError(null);
  }, [unitId]);

  // Re-check the batch's hold status independently of the Unit — a batch
  // can go on hold in the window between a Unit being minted and someone
  // paying for it, and `purchase_and_burn` re-checks this on-chain too, so
  // the UI needs to reflect the same possibility instead of just trusting
  // that a mintable-at-the-time Unit is still safe to redeem.
  const { data: batchData, isFetched: batchFetched, isError: batchError } = useSuiClientQuery(
    'getObject',
    { id: unit?.batchId ?? '', options: { showContent: true } },
    { enabled: Boolean(unit?.batchId) },
  );
  const batch = batchData ? parseBatchObject(batchData) : null;

  async function handlePay() {
    if (!unit) return;
    setError(null);
    setScratchCodeWrong(false);

    if (!scratchCode.trim()) {
      setError('The scratch code the pharmacy gave you separately is required — the QR alone cannot be redeemed.');
      return;
    }

    // Checked client-side purely so a wrong code fails fast with a clear
    // message instead of a generic transaction error — `purchase_and_burn`
    // re-checks this on-chain regardless, that's the real gate.
    const hex = await sha256Hex(scratchCode.trim());
    if (hex !== unit.secretHash) {
      setScratchCodeWrong(true);
      return;
    }

    // Move's purchase_and_burn re-hashes this itself (hash::sha2_256(secret)
    // == unit.secret_hash) — the argument here is the raw preimage bytes,
    // not the already-hashed value used for the client-side pre-check above.
    const secretBytes = utf8Bytes(scratchCode.trim());
    const tx = new Transaction();
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(unit.price)]);
    tx.moveCall({
      target: target('purchase_and_burn'),
      arguments: [
        tx.object(unit.objectId),
        tx.object(unit.batchId),
        payment,
        tx.pure.vector('u8', secretBytes),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: (result) => {
          setLastDigest(result.digest);
          toast.success('Payment confirmed on-chain. This sale QR has been redeemed.');
          refetch();
        },
        onError: (err) => toast.error(friendlyMoveError(err.message)),
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
        Scan the single-use QR on the package, enter the scratch code the pharmacy gave you
        separately, then pay directly from your wallet. Payment and redemption happen in the same
        transaction — the moment it confirms, this exact QR stops working for anyone, including
        you if you scan it again. The scratch code is required precisely because the QR alone
        (just an object ID) can be photographed and cloned like any barcode.
      </p>

      {!account && <ConnectWalletBanner action="pay for a package" />}
      {error && <p className="error-text">{error}</p>}
      {lastDigest && (
        <p className="success-banner">
          Payment confirmed on-chain. This sale QR has been redeemed. Transaction:{' '}
          <CodeChip value={lastDigest} href={explorerTxUrl(lastDigest)} title="View on Sui Explorer" />
        </p>
      )}

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

      {unitError && <p className="error-text">Could not read this sale QR. Check your connection and retry; its payment status is unknown.</p>}
      {unit && (batchError || (batchFetched && !batch)) && <p className="error-text">The batch could not be verified. Check the network and contract version before paying.</p>}
      {unitUnavailable && (
        <p className="error-text">
          No compatible sale object was found. It may have been redeemed, the ID may be wrong,
          or it may belong to another contract version. This lookup does not establish payment status.
        </p>
      )}

      {unit && batch?.isHeld && (
        <p className="error-text" style={{ marginTop: 16 }}>
          🚫 SALE BLOCKED — this batch is currently on hold ({batch.holdReason || 'no reason given'}
          ). Payment is disabled on-chain while a batch is held; do not accept this medicine even
          if offered outside this app.
        </p>
      )}

      {unit && batch && !batch.isHeld && batch.expiryMs <= Date.now() && (
        <p className="error-text" style={{ marginTop: 16 }}>
          🚫 SALE BLOCKED — this batch expired on {new Date(batch.expiryMs).toLocaleDateString()}.
          Payment is disabled on-chain for expired batches; do not accept this medicine.
        </p>
      )}

      {unit && !expired && !batch?.isHeld && batch && batch.expiryMs > Date.now() && (
        <div style={{ marginTop: 16 }}>
          <p className="helper-text">
            Price <span className="code-chip">{priceSui} SUI</span> · batch{' '}
            <CodeChip value={unit.batchId} /> · expires in{' '}
            <span className="code-chip">{remainingLabel}</span>
          </p>
          <div className="field">
            <label htmlFor="scratchCode">Scratch code (given to you separately by the pharmacy)</label>
            <input
              id="scratchCode"
              value={scratchCode}
              onChange={(e) => {
                setScratchCode(e.target.value);
                setScratchCodeWrong(false);
              }}
              placeholder="e.g. K7M3Q9WX"
              disabled={!account || isPending}
            />
          </div>
          {scratchCodeWrong && (
            <p className="error-text">
              That code doesn't match this QR. If someone showed you only the QR — no separate
              code — treat it as unpaid/unverified; the QR alone is not enough to prove this is a
              legitimate sale.
            </p>
          )}
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
