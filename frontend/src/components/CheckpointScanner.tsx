import { useState, type FormEvent } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, DEFAULT_NETWORK, TEMPERATURE_OFFSET_C, target } from '../lib/network';
import { useSignAndExecute } from '../lib/useSignAndExecute';
import { QrScanButton } from './QrScanButton';
import { extractBatchId } from '../lib/qr';
import { useToast } from '../lib/toast';
import { CodeChip } from './CodeChip';
import { ConnectWalletBanner } from './ConnectWalletBanner';
import { explorerTxUrl } from '../lib/explorer';
import { usePersistedState, LAST_BATCH_ID_KEY } from '../lib/persisted';

const ROLES = ['distributor', 'pharmacy', 'other'];

export function CheckpointScanner() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute, isPending } = useSignAndExecute();
  const toast = useToast();

  const [batchId, setBatchId] = usePersistedState(LAST_BATCH_ID_KEY, '');
  const [role, setRole] = useState(ROLES[0]);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [hasTemperature, setHasTemperature] = useState(false);
  const [temperatureC, setTemperatureC] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!batchId.trim() || !location.trim()) {
      setError('Batch object ID and location are both required.');
      return;
    }

    let temperatureCOffset = 0;
    if (hasTemperature) {
      const tempNum = Number(temperatureC);
      if (!temperatureC.trim() || !Number.isFinite(tempNum)) {
        setError('Enter a valid temperature, or uncheck "temperature measured" if there is none.');
        return;
      }
      // Move has no signed integer type — see TEMPERATURE_OFFSET_C's doc
      // comment in network.ts / pharma_track.move.
      temperatureCOffset = Math.round(tempNum) + TEMPERATURE_OFFSET_C;
      if (temperatureCOffset < 0) {
        setError(`Temperature is too far below the supported range (must be ≥ -${TEMPERATURE_OFFSET_C}°C).`);
        return;
      }
    }

    const tx = new Transaction();
    tx.moveCall({
      target: target('add_checkpoint'),
      arguments: [
        tx.object(batchId.trim()),
        tx.pure.string(role),
        tx.pure.string(location.trim()),
        tx.pure.string(note.trim()),
        tx.pure.bool(hasTemperature),
        tx.pure.u64(temperatureCOffset),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });

    signAndExecute(
      { transaction: tx, chain: `sui:${DEFAULT_NETWORK}` as `sui:${string}` },
      {
        onSuccess: (result) => {
          setLastDigest(result.digest);
          toast.success('Checkpoint recorded.');
          setLocation('');
          setNote('');
          setTemperatureC('');
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <section className="panel">
      <h2>Scan a checkpoint</h2>
      <p className="panel-intro">
        Called by whoever is taking custody of the batch right now — a distributor receiving a
        shipment, or a pharmacy stocking it. Your connected wallet address is recorded
        automatically as the actor; it can't be typed over or spoofed from this form.
      </p>

      {!account && <ConnectWalletBanner action="record a checkpoint" />}
      {error && <p className="error-text">{error}</p>}
      {lastDigest && (
        <p className="success-banner">
          Checkpoint recorded. Transaction:{' '}
          <CodeChip value={lastDigest} href={explorerTxUrl(lastDigest)} title="View on Sui Explorer" />
        </p>
      )}

      <QrScanButton onDecoded={(text) => setBatchId(extractBatchId(text))} />

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="batchId">Batch object ID</label>
          <input
            id="batchId"
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            placeholder="0x… (scan the batch's QR code, or paste manually)"
            disabled={!account || isPending}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="role">Your role</label>
            <select
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={!account || isPending}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="location">Location</label>
            <input
              id="location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. KL Distribution Hub"
              disabled={!account || isPending}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="note">Note (optional)</label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Received, seal intact"
            disabled={!account || isPending}
          />
        </div>

        <div className="field-row">
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              id="hasTemperature"
              type="checkbox"
              checked={hasTemperature}
              onChange={(e) => setHasTemperature(e.target.checked)}
              disabled={!account || isPending}
            />
            <label htmlFor="hasTemperature" style={{ marginBottom: 0 }}>
              Temperature measured (cold-chain)
            </label>
          </div>
          {hasTemperature && (
            <div className="field">
              <label htmlFor="temperatureC">Temperature (°C)</label>
              <input
                id="temperatureC"
                type="number"
                step="0.1"
                value={temperatureC}
                onChange={(e) => setTemperatureC(e.target.value)}
                placeholder="e.g. 5"
                disabled={!account || isPending}
              />
            </div>
          )}
        </div>

        <button type="submit" className="btn btn-primary" disabled={!account || isPending}>
          {isPending ? 'Recording on-chain…' : 'Record checkpoint'}
        </button>
      </form>
    </section>
  );
}
