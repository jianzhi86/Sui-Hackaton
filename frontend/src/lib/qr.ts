/**
 * Batch QR codes encode a full verification URL (so a plain phone camera
 * app can open the page directly). This unwraps that back down to the raw
 * object ID; if the scanned text isn't a URL, it's treated as already being
 * a raw ID (useful for manual paste-in or barcode formats that only carry
 * the ID).
 */
export function extractBatchId(decoded: string): string {
  try {
    const url = new URL(decoded);
    const fromParam = url.searchParams.get('batch');
    if (fromParam) return fromParam;
  } catch {
    // Not a URL — fall through and treat the raw text as the ID.
  }
  return decoded.trim();
}

/**
 * A `Unit`'s single-use QR encodes `?unit=<objectId>` the same way a
 * batch's QR encodes `?batch=<objectId>`; see `extractBatchId`.
 */
export function extractUnitId(decoded: string): string {
  try {
    const url = new URL(decoded);
    const fromParam = url.searchParams.get('unit');
    if (fromParam) return fromParam;
  } catch {
    // Not a URL — fall through and treat the raw text as the ID.
  }
  return decoded.trim();
}

/**
 * Per-item verify QRs (one per physical package, printed onto that exact
 * package) encode `?batch=<objectId>&serial=<n>`. The serial isn't a
 * separate on-chain object — it's a print/label-tracking number layered
 * on top of the one shared `Batch` every item in a print run belongs to.
 * Returns `null` if the scanned text carries no serial (e.g. a plain
 * batch QR without one).
 */
export function extractSerial(decoded: string): string | null {
  try {
    const url = new URL(decoded);
    return url.searchParams.get('serial');
  } catch {
    return null;
  }
}
