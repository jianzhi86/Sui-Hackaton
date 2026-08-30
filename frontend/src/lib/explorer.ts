import { DEFAULT_NETWORK } from './network';

/**
 * Suiscan URLs follow `/<network>/<kind>/<id>` (mainnet omits the network
 * segment on some explorers, but Suiscan accepts `mainnet` explicitly too,
 * so we always include it for consistency across all three networks).
 */
function suiscanUrl(kind: 'tx' | 'object' | 'account', id: string): string {
  return `https://suiscan.xyz/${DEFAULT_NETWORK}/${kind}/${id}`;
}

export const explorerTxUrl = (digest: string) => suiscanUrl('tx', digest);
export const explorerObjectUrl = (objectId: string) => suiscanUrl('object', objectId);
export const explorerAddressUrl = (address: string) => suiscanUrl('account', address);
