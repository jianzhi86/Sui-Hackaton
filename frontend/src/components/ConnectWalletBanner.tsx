interface ConnectWalletBannerProps {
  /** What the wallet is needed for, e.g. "register a batch" — reads as
   * "Connect your wallet to {action}." */
  action: string;
}

/**
 * A single, visually consistent "you need a wallet for this" prompt, used
 * everywhere a form is otherwise just a greyed-out field with small print
 * underneath — that pattern reads as "broken" more than "needs a wallet"
 * until someone reads the fine text. This is deliberately louder.
 */
export function ConnectWalletBanner({ action }: ConnectWalletBannerProps) {
  return (
    <div className="connect-banner">
      <span className="connect-banner-icon" aria-hidden="true">🔌</span>
      <div>
        <strong>Connect your wallet</strong>
        <p>You'll need a connected wallet to {action}.</p>
      </div>
    </div>
  );
}
