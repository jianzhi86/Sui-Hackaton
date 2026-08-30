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

/**
 * Object ID of the shared `RegulatorRegistry`, created once at publish
 * time by `init` — unlike `PACKAGE_ID`, this can't be derived from
 * anything else, since a shared object's ID is only known from the
 * publish transaction's output ("Created Objects" — the one with type
 * `...::batch::RegulatorRegistry`). Copy it into `.env` as
 * `VITE_REGISTRY_OBJECT_ID` alongside `VITE_PACKAGE_ID` after publishing.
 */
export const REGISTRY_OBJECT_ID = import.meta.env.VITE_REGISTRY_OBJECT_ID || '0x0';

/**
 * Object ID of the shared `ManufacturerRegistry`, created once at publish
 * time alongside `RegulatorRegistry` — same caveat: not derivable from
 * the package ID, copy it from the same publish output ("Created
 * Objects" — the one with type `...::batch::ManufacturerRegistry`) into
 * `.env` as `VITE_MANUFACTURER_REGISTRY_OBJECT_ID`.
 */
export const MANUFACTURER_REGISTRY_OBJECT_ID =
  import.meta.env.VITE_MANUFACTURER_REGISTRY_OBJECT_ID || '0x0';

export const MODULE_NAME = 'batch';

/** Sui's shared Clock object always lives at this fixed address. */
export const CLOCK_OBJECT_ID = '0x6';

/**
 * How long a `Unit` stays redeemable after minting, in milliseconds. Must
 * match `UNIT_EXPIRY_MS` in `pharma_track.move` — kept here too so the UI
 * can show a countdown and disable payment locally instead of waiting for
 * `purchase_and_burn` to abort on-chain.
 */
export const UNIT_EXPIRY_MS = 600_000;

/**
 * Offset added to a Celsius reading before it's stored on-chain as a
 * `u64` (Move has no signed integer type). Must match `TEMPERATURE_OFFSET_C`
 * in `pharma_track.move`.
 */
export const TEMPERATURE_OFFSET_C = 200;

type NetworkName = 'devnet' | 'testnet' | 'mainnet';
const VALID_NETWORKS: readonly NetworkName[] = ['devnet', 'testnet', 'mainnet'];

/**
 * `VITE_SUI_NETWORK`'s type annotation in vite-env.d.ts only constrains it
 * at compile time — a typo'd or stray value in an actual deployment's env
 * vars (e.g. Vercel project settings) passes straight through as a plain
 * string at runtime. Without this guard, a bad value here makes
 * `SuiClientProvider` do `networks[defaultNetwork].network` against a key
 * that doesn't exist, throwing "Cannot read properties of undefined
 * (reading 'network')" and white-screening the entire app before anything
 * renders — confirmed live on the deployed build (2026-08-29). Falling
 * back to 'testnet' here means a misconfigured env var degrades to "wrong
 * network" instead of "site doesn't load at all".
 */
function resolveDefaultNetwork(): NetworkName {
  const raw = import.meta.env.VITE_SUI_NETWORK;
  if (VALID_NETWORKS.includes(raw as NetworkName)) return raw as NetworkName;
  if (raw) {
    console.warn(
      `VITE_SUI_NETWORK is set to "${raw}", which isn't one of ${VALID_NETWORKS.join('/')}. Falling back to "testnet".`,
    );
  }
  return 'testnet';
}

export const DEFAULT_NETWORK: NetworkName = resolveDefaultNetwork();

export const { networkConfig } = createNetworkConfig({
  devnet: { url: RPC_URLS.devnet, network: 'devnet' },
  testnet: { url: RPC_URLS.testnet, network: 'testnet' },
  mainnet: { url: RPC_URLS.mainnet, network: 'mainnet' },
});

export function target(fn: string): `${string}::${string}::${string}` {
  return `${PACKAGE_ID}::${MODULE_NAME}::${fn}`;
}
