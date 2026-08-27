// NOTE: @mysten/dapp-kit (legacy) is built on the JSON-RPC client, so we
// pull the fullnode URL helper from `@mysten/sui/jsonRpc` rather than
// `@mysten/sui/client` (which now points at the newer gRPC-based client).
// The SDK marks JSON-RPC as deprecated in favor of SuiGrpcClient /
// SuiGraphQLClient, but dapp-kit 1.x — the far better-documented, more
// beginner-friendly path — still requires it. See the README for the
// tradeoff and how to migrate later.
import { createNetworkConfig } from '@mysten/dapp-kit';

// Mysten's own public fullnodes (getFullnodeUrl / getJsonRpcFullnodeUrl)
// have deprecated the JSON-RPC API entirely — a POST to
// https://fullnode.testnet.sui.io now returns "Method not found. JSON-RPC
// on public fullnodes has been deprecated", and without CORS headers on
// top of that, which breaks every browser call dapp-kit (legacy, JSON-RPC
// based) makes. publicnode.com still runs full JSON-RPC nodes with CORS
// enabled, so we point there instead. Swap in your own node/provider URL
// if you have one.
const RPC_URLS = {
  devnet: 'https://sui-devnet-rpc.publicnode.com',
  testnet: 'https://sui-testnet-rpc.publicnode.com',
  mainnet: 'https://sui-rpc.publicnode.com',
};

/**
 * Package ID of the published `pharma_track` Move package.
 *
 * This is `0x0` until you publish the contract. Run:
 *   cd contract && sui client publish --gas-budget 100000000
 * then copy the printed Package ID into your `.env` as VITE_PACKAGE_ID
 * (see .env.example).
 */
export const PACKAGE_ID = import.meta.env.VITE_PACKAGE_ID || '0x0';

export const MODULE_NAME = 'batch';

/** Sui's shared Clock object always lives at this fixed address. */
export const CLOCK_OBJECT_ID = '0x6';

export const DEFAULT_NETWORK: 'devnet' | 'testnet' | 'mainnet' =
  import.meta.env.VITE_SUI_NETWORK || 'testnet';

export const { networkConfig } = createNetworkConfig({
  devnet: { url: RPC_URLS.devnet, network: 'devnet' },
  testnet: { url: RPC_URLS.testnet, network: 'testnet' },
  mainnet: { url: RPC_URLS.mainnet, network: 'mainnet' },
});

export function target(fn: string): `${string}::${string}::${string}` {
  return `${PACKAGE_ID}::${MODULE_NAME}::${fn}`;
}
