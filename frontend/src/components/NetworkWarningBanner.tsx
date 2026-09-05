import { useCurrentAccount } from '@mysten/dapp-kit';
import { DEFAULT_NETWORK } from '../lib/network';

/**
 * Confirmed live: a wallet whose active network doesn't match the app's
 * network (e.g. Slush set to Mainnet while this app targets Testnet) lets
 * you fill out an entire form before failing at the sign step with a
 * scary-looking "unable to verify site security" / "unable to process
 * transaction" popup — by then you've already lost the time spent on the
 * form. `WalletAccount.chains` reflects the account's *currently active*
 * chain context for wallets that narrow it on network switch (Slush does),
 * so this catches the mismatch proactively instead of waiting for the
 * wallet's own popup. Deliberately conservative: only warns when `chains`
 * is non-empty and explicitly excludes the target network, never when it's
 * empty or ambiguous, so a wallet that doesn't narrow `chains` this way
 * simply shows nothing rather than a false alarm.
 */
export function NetworkWarningBanner() {
  const account = useCurrentAccount();
  if (!account || account.chains.length === 0) return null;

  const expectedChain = `sui:${DEFAULT_NETWORK}` as const;
  if (account.chains.includes(expectedChain)) return null;

  return (
    <div className="error-text" style={{ marginBottom: 16 }}>
      ⚠ Your wallet looks like it's set to a different network than this app ({DEFAULT_NETWORK}
      ). Open your wallet extension and switch its network to <strong>{DEFAULT_NETWORK}</strong>{' '}
      before signing anything — otherwise you'll hit a confusing "unable to process transaction"
      warning at the very last step.
    </div>
  );
}
