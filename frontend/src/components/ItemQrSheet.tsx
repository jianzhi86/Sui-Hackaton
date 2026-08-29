import { useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface ItemQrSheetProps {
  batchId: string;
  batchCode: string;
}

/**
 * Generates one verify QR per physical package in a print run — each
 * encodes the same shared `Batch` object ID plus a distinct `serial`
 * number, so every individual medicine gets its own printable, scannable
 * label while still verifying against the one on-chain batch record.
 *
 * This is entirely client-side (no wallet, no transaction, no gas): the
 * serial is a labeling convention, not separate on-chain state, so there's
 * nothing to sign to print a thousand of these.
 */
export function ItemQrSheet({ batchId, batchCode }: ItemQrSheetProps) {
  const [quantity, setQuantity] = useState('10');
  const [serials, setSerials] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleGenerate(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1) {
      setError('Enter a whole number of at least 1.');
      return;
    }
    if (count > 500) {
      setError('Generate at most 500 at a time — split larger print runs into batches.');
      return;
    }

    setSerials(Array.from({ length: count }, (_, i) => i + 1));
  }

  const origin = `${window.location.origin}${window.location.pathname}`;

  return (
    <div style={{ marginTop: 24 }}>
      <details open={serials === null}>
        <summary className="helper-text" style={{ cursor: 'pointer' }}>
          Generate one verify QR per physical package (for printing)
        </summary>

        <form onSubmit={handleGenerate} style={{ marginTop: 12 }} className="no-print">
          <div className="field">
            <label htmlFor="itemQty">How many packages need a label?</label>
            <input
              id="itemQty"
              type="number"
              min="1"
              max="500"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn btn-secondary">
            Generate {quantity || ''} QR codes
          </button>
        </form>
      </details>

      {serials && (
        <div style={{ marginTop: 16 }}>
          <div className="no-print" style={{ marginBottom: 12 }}>
            <p className="helper-text">
              {serials.length} verify QR{serials.length === 1 ? '' : 's'} for batch{' '}
              <span className="code-chip">{batchCode}</span>, each scannable and unique to one
              physical package. Print this page (or just this section) and cut apart the labels.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => window.print()}>
              Print
            </button>
          </div>

          <div className="print-sheet">
            {serials.map((serial) => (
              <div className="qr-card qr-card-compact" key={serial}>
                <QRCodeSVG value={`${origin}?batch=${batchId}&serial=${serial}`} size={128} level="M" />
                <div style={{ fontSize: 11, fontWeight: 600 }}>
                  {batchCode} · #{serial}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
