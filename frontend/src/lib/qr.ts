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
