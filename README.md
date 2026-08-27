# PharmaTrust — Batch Verification Register

A hackathon MVP for the **MUBA Blockchain Hackathon 2026**, targeting the
**Gonka Router "AI For Society"** track (primary) and, optionally, the
**Sui Foundation "AI × Sui"** track (the same build already covers it).

**The pitch in one line:** blockchain proves what's genuine, AI catches what's cloned.

Every drug batch becomes an object on Sui at manufacture. Each handoff —
manufacturer → distributor → pharmacy — adds a permanent, publicly-visible
checkpoint. Anyone (pharmacist or patient) scans the final QR code and sees
the whole verified chain of custody instantly, plus an AI cross-check (two
independent models via Gonka Router) that flags timing gaps, skipped steps,
or duplicate/cloned scans.

## Repo layout

```
contract/            Sui Move package (the on-chain half)
  sources/pharma_track.move
  tests/pharma_track_tests.move
  Move.toml
frontend/             React + Vite app (the off-chain half)
  src/
    lib/               network config, Sui object parsing, Gonka integration, rule-based checks
    components/        Register / Scan / Verify screens, QR code + scanner, AI report panel
```

## What each piece actually does

| Piece | Role |
|---|---|
| `pharma_track::batch` (Move) | `create_batch` shares a new `Batch` object; `add_checkpoint` appends a custody event with the caller's real address, no admin gate — trust comes from public visibility, not access control |
| Register tab | Manufacturer calls `create_batch`, gets back a QR code encoding a verify URL |
| Scan tab | Distributor/pharmacy calls `add_checkpoint` against an existing batch |
| Verify tab | Public, no wallet needed — reads the object straight from Sui, renders the ledger, and can run the AI check |
| `src/lib/gonka.ts` | Sends the custody timeline to **two** Gonka-hosted models, in parallel, and reports agreement/disagreement + a combined risk score |
| `src/lib/chainAnalysis.ts` | Zero-cost local checks (timing gaps, skipped steps, duplicate scans) that run before *and independently of* the AI call, so the demo never goes blank on bad wifi |

## Before you demo: three things to verify yourself

I built this without live access to `gonkarouter.io` or a working `sui`
CLI in the environment I wrote it in, so here's exactly what's confirmed
vs. assumed:

**✅ Confirmed by actually building it here:**
- The frontend installs and **compiles clean** (`tsc` + `vite build`) against the real, currently-published versions of `@mysten/sui` (2.26.2) and `@mysten/dapp-kit` (1.1.17) — I hit and fixed two real breaking-change issues in the process (see "SDK quirks" below), so this isn't just copy-pasted-and-hoped-for-the-best code.
- Every Move syntax choice (struct/object rules, method syntax, `test_scenario` patterns, `Move.toml` shape) was cross-checked against current Sui documentation and framework source.

**⚠️ Not independently verified — check these before judging day:**
1. **Move contract compilation.** I don't have the `sui` CLI available in this environment, so `pharma_track.move` has not actually been run through `sui move build` or `sui move test`. Run this yourself first:
   ```
   cd contract
   sui move test
   ```
   If anything fails, it's most likely a minor syntax drift, not a design problem — the logic itself (share the batch, append checkpoints, read history) is straightforward.
2. **Gonka Router's exact API shape.** `src/lib/gonka.ts` assumes an OpenAI-compatible `POST {base}/chat/completions` endpoint with `Authorization: Bearer <key>` and a `choices[0].message.content` response — this is the de facto standard most routers follow, and Gonka's own naming suggests the same, but I could not reach `gonkarouter.io` to confirm it byte-for-byte. Confirm the base URL, auth header, and response envelope against the official docs or their MCP tool, then adjust the one function `callGonkaModel` if needed — nothing else depends on the exact shape.
3. **Model identifiers.** `minimax` and `kimi` are placeholders from the hackathon brief's example — confirm the actual model strings Gonka Router exposes.

## Setup

### 1. Deploy the contract (testnet)

```bash
cd contract
sui client switch --env testnet          # make sure you're on testnet
sui client faucet                        # top up gas if needed
sui move test                            # confirm it compiles + tests pass (see caveat above)
sui client publish --gas-budget 100000000
```

Copy the **Package ID** from the publish output.

### 2. Configure and run the frontend

```bash
cd frontend
npm install
cp .env.example .env
# edit .env:
#   VITE_PACKAGE_ID=<the package id you just published>
#   VITE_GONKA_BASE_URL / VITE_GONKA_API_KEY / model names — confirm against Gonka docs
npm run dev
```

You'll also want a Sui wallet browser extension (e.g. Sui Wallet, Slush)
switched to testnet, with some testnet SUI from `sui client faucet` or the
in-wallet faucet button, to sign the Register/Scan transactions.

## Demo script (fits the 2-minute video requirement)

1. **Register** — as the "manufacturer" wallet, register a batch (e.g. "Amoxicillin 500mg"). Show the QR code it produces.
2. **Scan** — switch wallets (or just narrate it), scan/paste the batch ID, add a "distributor" checkpoint at a plausible location.
3. **Verify** — scan the final QR (or open the verify link) with no wallet connected at all, to make the point that verification is public. Show the ledger.
4. **Run AI verification** — click through and show the two-model consensus, the risk score, and the Gonka request IDs (this last part is explicitly judged — don't skip showing it).
5. **The money shot** — go back to Scan and add an implausible checkpoint (e.g. same role/location scanned twice, or a huge time gap), re-run verification, and show it get flagged. This is the moment that sells the pitch.

## SDK quirks worth knowing (in case you extend this)

- `@mysten/sui/client` in the currently-published SDK is the *new* gRPC-based client; the legacy JSON-RPC helpers (`getFullnodeUrl`, used by `@mysten/dapp-kit` 1.x) now live at `@mysten/sui/jsonRpc` as `getJsonRpcFullnodeUrl`, and `createNetworkConfig` entries need an explicit `network` field alongside `url`. `src/lib/network.ts` already does this correctly — just don't "fix" it back to the old import path if you see older tutorials online.
- `@mysten/dapp-kit` itself is marked legacy in favor of `@mysten/dapp-kit-react` (gRPC-based). Legacy still works and is far better documented, which is why this scaffold uses it — but it's worth knowing if you hit a wall and want to check the newer package's docs instead.

## Known limitations / good next steps if you have time left

- **No access control** on `add_checkpoint` — anyone can add a checkpoint under their own address. That's a deliberate MVP simplification (trust through public attribution, not permissioning); a real version would add a `ManufacturerCap`/`DistributorCap` capability object so only approved supply-chain members can write.
- **No cold-chain data.** The brief mentioned temperature excursions as an anomaly signal — this scaffold only reasons over timing/sequence, not sensor data. Adding a `temperature_c` field to `Checkpoint` and a corresponding rule in `chainAnalysis.ts` is a small, demo-able extension if you want it.
- **Single demo dataset.** There's no real pharmacy registry to check against — be upfront in your pitch that the AI is reasoning over the custody *pattern*, not cross-referencing a real drug database.
