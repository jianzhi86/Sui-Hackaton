import { ConnectButton } from '@mysten/dapp-kit';
import type { Tab } from '../App';

interface HeaderProps {
  active: Tab;
  onNavigate: (tab: Tab) => void;
}

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: 'register', label: 'Register batch', hint: 'Manufacturer' },
  { key: 'scan', label: 'Scan checkpoint', hint: 'Distributor / pharmacy' },
  { key: 'verify', label: 'Verify a product', hint: 'Anyone' },
];

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

      <ConnectButton />
    </header>
  );
}
