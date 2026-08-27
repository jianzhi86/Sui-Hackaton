import { QRCodeSVG } from 'qrcode.react';

interface QrCodeCardProps {
  value: string;
  label: string;
  helper?: string;
}

export function QrCodeCard({ value, label, helper }: QrCodeCardProps) {
  return (
    <div className="qr-card">
      <QRCodeSVG value={value} size={176} level="M" />
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </div>
        <div className="code-chip" style={{ marginTop: 6, display: 'inline-block' }}>
          {value}
        </div>
      </div>
      {helper && <p className="helper-text">{helper}</p>}
    </div>
  );
}
