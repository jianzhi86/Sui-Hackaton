/**
 * Maps `pharma_track.move`'s abort codes to plain-English messages. Sui's
 * default error surfaces as raw text like "MoveAbort in 1st command, abort
 * code: 2, in '...::batch::add_checkpoint'" — technically correct, but
 * meaningless to someone who didn't write the contract. Must be kept in
 * sync with the `const E...: u64 = N` list in pharma_track.move.
 */
const ABORT_MESSAGES: Record<number, string> = {
  0: 'Batch code cannot be empty.',
  1: 'Product name cannot be empty.',
  2: 'This batch is currently on hold — release it first before recording checkpoints, minting sale QRs, or accepting payment.',
  3: 'This action requires the batch to currently be on hold, but it isn\'t.',
  4: 'A hold reason cannot be empty.',
  5: 'Price must be greater than zero.',
  6: 'The payment amount doesn\'t match the price.',
  7: 'This sale QR has expired — ask for a fresh one.',
  8: 'Invalid severity level.',
  9: 'A case/investigation reference cannot be empty.',
  10: 'A release note cannot be empty.',
  11: 'This sale QR doesn\'t belong to the batch it was scanned against.',
  12: 'Critical holds cannot be released by a single signer — this needs a second, different address to confirm.',
  13: 'A release has already been proposed for this hold.',
  14: 'No release has been proposed for this hold yet.',
  15: 'The same address that proposed the release cannot also confirm it — a different signer is required.',
  19: 'Invalid hold category.',
  23: 'Expiry date must be in the future.',
  24: 'This batch has expired — sale QRs can no longer be minted or redeemed for it.',
  25: 'Invalid secret hash.',
  26: 'That scratch code doesn\'t match this sale QR.',
  31: 'This hold has already been flagged as overdue.',
  32: 'This hold hasn\'t been open long enough to flag as overdue yet.',
  33: 'A suspicion note cannot be empty.',
  34: 'Only this batch\'s manufacturer can do that.',
  35: 'Stake stays locked until the batch expires.',
  36: 'There\'s no stake left to withdraw.',
  40: 'The bond is below the required minimum.',
  46: 'Enter a positive amount to add to the stake.',
};

/**
 * Rewrites a raw Sui error message into something a non-developer can act
 * on, when it recognizes a `pharma_track` MoveAbort code. Falls back to the
 * original message untouched for anything else (network errors, wallet
 * rejections, unrecognized codes) rather than risk hiding useful detail.
 */
export function friendlyMoveError(message: string): string {
  const match = message.match(/abort code:\s*(\d+)/i);
  if (!match) return message;
  const code = Number(match[1]);
  const friendly = ABORT_MESSAGES[code];
  return friendly ? friendly : message;
}
