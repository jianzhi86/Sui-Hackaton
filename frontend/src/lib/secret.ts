/**
 * One-time "scratch-off" secrets for sale QRs — see the module doc
 * comment on `Unit`/`mint_unit`/`purchase_and_burn` in pharma_track.move
 * for why this exists: the visible QR alone (just an object ID) can be
 * photographed and cloned like any barcode, so `mint_unit` also requires
 * a SHA-256 hash of a secret that the pharmacy must deliver to the buyer
 * through a *different* channel (told verbally, printed on a receipt,
 * under a physical scratch panel) — never embedded in the printed QR.
 */

const SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L — easy to read/write by hand

/** A short, hand-writable random code — not cryptographically unguessable
 * on its own at this length, but it doesn't need to be: it's a second
 * factor alongside the QR's object ID, not a standalone secret. */
export function generateSecret(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => SECRET_ALPHABET[b % SECRET_ALPHABET.length]).join('');
}

/** Raw UTF-8 bytes of a string, as a `number[]` — the shape Move's
 * `purchase_and_burn` expects for its `secret: vector<u8>` argument (the
 * *preimage*, not its hash; Move re-hashes this itself to compare against
 * `Unit.secret_hash`). */
export function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** SHA-256 of a UTF-8 string, as a `number[]` of bytes — the shape
 * `tx.pure.vector('u8', ...)` expects for Move's `vector<u8>`. Uses the
 * browser's native Web Crypto API (SHA-2 family only; that's why the
 * contract uses `std::hash::sha2_256`, not a Keccak/SHA-3 variant that
 * would need an extra JS dependency to match). */
export async function sha256Bytes(text: string): Promise<number[]> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest));
}

/** Hex-encoded SHA-256, for comparing against `UnitRecord.secretHash`
 * (which `suiRead.ts` already renders as hex) without needing to touch a
 * Move call — used by the payer's UI to validate a scratch code locally
 * before building a transaction that would otherwise abort on-chain. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = await sha256Bytes(text);
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
