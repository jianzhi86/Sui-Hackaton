import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import '@mysten/dapp-kit/dist/index.css';

import { networkConfig, DEFAULT_NETWORK } from './lib/network';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './lib/toast';
import App from './App';
import './index.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside SuiClientProvider/WalletProvider on purpose — a crash in
        network config (like the invalid-VITE_SUI_NETWORK bug this was
        added for) happens inside those providers, so the boundary has to
        wrap them, not sit inside them. */}
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SuiClientProvider networks={networkConfig} defaultNetwork={DEFAULT_NETWORK}>
          <WalletProvider autoConnect>
            <ToastProvider>
              <App />
            </ToastProvider>
          </WalletProvider>
        </SuiClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
