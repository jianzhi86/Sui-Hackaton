import { useState } from 'react';

interface CodeChipProps {
  value: string;
  /** If given, the chip links out to this URL (e.g. a Sui Explorer page)
   * in a new tab, in addition to being copyable. */
  href?: string;
  title?: string;
}

/**
 * A `code-chip` (address/object-ID/digest display) with a one-click copy
 * button and an optional Explorer link. Replaces the plain
 * `<span className="code-chip">` used everywhere before this — those were
 * unreadable to copy by hand on mobile and dead-ended instead of linking
 * out to a block explorer.
 */
export function CodeChip({ value, href, title }: CodeChipProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (non-HTTPS context, denied
      // permission) — the value is still visible to select/copy by hand.
    }
  }

  return (
    <span className="code-chip-group">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="code-chip" title={title}>
          {value}
        </a>
      ) : (
        <span className="code-chip" title={title}>
          {value}
        </span>
      )}
      <button type="button" className="copy-btn" onClick={handleCopy} aria-label="Copy to clipboard">
        {copied ? '✓' : '⧉'}
      </button>
    </span>
  );
}
