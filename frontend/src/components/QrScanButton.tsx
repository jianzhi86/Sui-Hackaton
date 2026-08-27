import { useEffect, useRef, useState } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';

interface QrScanButtonProps {
  onDecoded: (text: string) => void;
}

let instanceCounter = 0;

export function QrScanButton({ onDecoded }: QrScanButtonProps) {
  const [scanning, setScanning] = useState(false);
  const elementId = useRef(`qr-reader-${instanceCounter++}`).current;
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  useEffect(() => {
    if (!scanning) return;

    const scanner = new Html5QrcodeScanner(elementId, { fps: 10, qrbox: 220 }, false);
    scannerRef.current = scanner;

    scanner.render(
      (decodedText) => {
        onDecoded(decodedText);
        scanner.clear().catch(() => {});
        setScanning(false);
      },
      () => {
        // Per-frame scan misses are expected while the camera hunts for a
        // code — nothing to surface to the user here.
      },
    );

    return () => {
      scanner.clear().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  return (
    <div className="scan-target">
      {!scanning ? (
        <button type="button" className="btn btn-secondary" onClick={() => setScanning(true)}>
          Scan QR with camera
        </button>
      ) : (
        <>
          <div id={elementId} style={{ width: 280, maxWidth: '100%' }} />
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 8 }}
            onClick={() => setScanning(false)}
          >
            Cancel scan
          </button>
        </>
      )}
    </div>
  );
}
