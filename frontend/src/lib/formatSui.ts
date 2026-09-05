import { MIST_PER_SUI } from '@mysten/sui/utils';

/**
 * Every SUI-denominated input in this app (stake, price, bond) gets
 * rounded to the nearest MIST before being sent on-chain — `Math.round(sui
 * * Number(MIST_PER_SUI))`. Surfacing that exact integer back to the user
 * before they sign is what makes "0.1 SUI" a confirmed fact instead of a
 * hopeful approximation; floating-point input can otherwise round in a way
 * that's surprising (e.g. an input the browser stored as 0.1000000000001).
 */
export function mistPreview(suiAmount: number): string {
  if (!Number.isFinite(suiAmount) || suiAmount < 0) return '';
  const mist = BigInt(Math.round(suiAmount * Number(MIST_PER_SUI)));
  return `= ${mist.toLocaleString()} MIST`;
}
