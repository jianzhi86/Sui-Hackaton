import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Wraps the whole app (including SuiClientProvider/WalletProvider) so a
 * crash there — e.g. the VITE_SUI_NETWORK misconfiguration that white-
 * screened the live deployment on 2026-08-29 — shows a recoverable error
 * screen instead of a blank page with nothing but a console error nobody
 * but a developer would find.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Uncaught error in PharmaTrust UI:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-shell">
          <section className="panel" style={{ marginTop: 40 }}>
            <h2>Something went wrong</h2>
            <p className="panel-intro">
              The app hit an unexpected error and stopped instead of silently breaking. This is
              usually a configuration issue (e.g. a bad environment variable) rather than a
              problem with any on-chain data — nothing was lost.
            </p>
            <p className="error-text">{this.state.error.message}</p>
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}
