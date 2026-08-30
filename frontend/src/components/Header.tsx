import { useState } from 'react';
import { ConnectButton } from '@mysten/dapp-kit';
import { QRCodeSVG } from 'qrcode.react';
import type { Tab } from '../App';

interface HeaderProps {
  active: Tab;
  onNavigate: (tab: Tab) => void;
}

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'register', label: 'Register batch', hint: 'Manufacturer' },
  { key: 'scan', label: 'Scan checkpoint', hint: 'Distributor / pharmacy' },
  { key: 'verify', label: 'Verify a product', hint: 'Anyone' },
  { key: 'holds', label: 'Active Holds', hint: 'Public recall registry' },
  { key: 'stats', label: 'Stats', hint: 'System-wide activity' },
  { key: 'mint', label: 'Create sale QR', hint: 'Pharmacy' },
  { key: 'pay', label: 'Pay & dispense', hint: 'Customer' },
];

/**
 * Scan-to-open button: shows a QR of the current page URL so someone can
 * pick this up on a phone instantly, without typing a URL. There's no
 * universal deep-link scheme across Sui wallet apps to jump straight into
 * a signing flow, so this solves the more general problem underneath it —
 * getting the right page in front of someone on their phone at all — and
 * from there, a phone's Sui wallet app in-app browser (Slush, Sui Wallet)
 * can open the link and connect normally.
 */
function OpenOnPhoneButton() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen((o) => !o)}>
        📱 Open on phone
      </button>
      {open && (
        <div
          className="qr-card"
          style={{ position: 'absolute', top: '110%', right: 0, zIndex: 20, width: 220 }}
        >
          <QRCodeSVG value={window.location.href} size={160} level="M" />
          <p className="helper-text" style={{ marginTop: 4 }}>
            Scan with your phone's camera, then open the link inside your Sui wallet app's
            built-in browser (Slush, Sui Wallet) to connect and sign from there.
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

export function Header({ active, onNavigate }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          Rx
        </span>
        <div>
          <h1>PharmaTrust</h1>
          <p className="brand-sub">Batch verification register</p>
        </div>
      </div>

      <nav className="tab-rail" aria-label="Sections">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tab-button ${active === tab.key ? 'is-active' : ''}`}
            onClick={() => onNavigate(tab.key)}
            aria-current={active === tab.key ? 'page' : undefined}
          >
            <span className="tab-label">{tab.label}</span>
            <span className="tab-hint">{tab.hint}</span>
          </button>
        ))}
      </nav>

      <OpenOnPhoneButton />
      <ConnectButton />
    </header>
  );
}
