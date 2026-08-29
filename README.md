# PharmaTrust — On-Chain Pharmaceutical Custody & Anti-Counterfeit Register

A Sui + AI project built for a hackathon, targeting:

- **Sui Track 02 — AI × Sui** (primary): on-chain ownership/custody, payments, and AI-driven verification in one product.
- **Gonka "AI for Society"** (secondary submission): the AI cross-check below satisfies Gonka Router's full mandatory checklist — multi-model consensus, a Truth-Score-equivalent, a reasoning trail, and visible Gonka Request IDs.

**The pitch in one line:** blockchain proves custody, single-use QR codes prove a sale can't be double-charged or replayed, and independent AI models catch what looks cloned or tampered.

## What it does

1. A manufacturer registers a drug **batch** on Sui — a shared object every later party can attach to.
2. Distributors/pharmacies add **checkpoints** as the batch physically moves — permanently attributed to whoever's wallet signed it, no way to forge who touched it.
3. A regulator can **place a hold** (with a severity level, a case reference, and — on release — a mandatory explanation) to freeze the custody chain during an investigation or recall.
4. Anyone can **verify** a batch with no wallet at all, see its full history, and run a live **AI cross-check**: two independent models (via Gonka Router) reason over the custody timeline in parallel and flag impossible timing, skipped steps, or duplicate scans.
5. A pharmacy can **mint a single-use sale QR** at checkout; a customer scans and **pays** in the same transaction — the on-chain object is deleted the instant it's paid, so the exact same QR can never be charged twice, and it expires after 10 minutes if unused.
6. A manufacturer/pharmacy can **generate and print** a batch of individually-numbered verify QR codes — one per physical package — for labeling a real print run.

## Repo layout

```
contract/                     Sui Move package (the on-chain half)
  sources/pharma_track.move   Batch, Checkpoint, HoldRecord, RegulatorCap, Unit
  tests/pharma_track_tests.move  14 unit tests (test with `sui move test`)
  Move.toml / Published.toml

frontend/                     React + Vite app (the off-chain half)
  api/gonka.ts                 Vercel serverless function — proxies Gonka Router calls server-side
  vite.config.ts                Mirrors api/gonka.ts as a dev-server middleware for local testing
  src/
    lib/                       network config, Sui object parsing, Gonka integration, rule-based checks, QR helpers
    components/                Register / Scan / Verify / Mint / Pay screens, QR generation + scanning, hold controls, AI report panel
```

## What each piece does

| Piece | Role |
|---|---|
| `Batch` (Move) | Shared object created by `create_batch`; accumulates `Checkpoint`s via `add_checkpoint` (no access gate — trust comes from public attribution, not permissioning) |
| `RegulatorCap` (Move) | Capability object required to place/release holds; minted once at publish, holders can mint more to onboard other regulators |
| Hold system | `place_hold` requires a severity (Advisory / Recall / Critical), a mandatory case reference, and freezes `add_checkpoint`; `release_hold` requires a mandatory release note explaining why it's safe. Every cycle is kept forever in `hold_history`, even after release |
| `Unit` (Move) | A single-use, shared "sale ticket" for one physical package. `mint_unit` creates it with a price and a 10-minute expiry; `purchase_and_burn` takes exact payment, forwards it to the manufacturer, and **deletes the object** — the QR pointing at it becomes permanently unredeemable, which is what makes it single-use (not a flag that could be bypassed, an object that stops existing) |
| Register tab | Manufacturer calls `create_batch`; also generates the printable per-item verify QR sheet |
| Scan tab | Distributor/pharmacy calls `add_checkpoint` |
| Verify tab | Public, no wallet needed — reads the object straight from Sui, shows the ledger + hold history, runs the AI check, and can also generate item QR codes for an existing batch |
| Create sale QR tab | Pharmacy calls `mint_unit` at checkout |
| Pay & dispense tab | Customer scans/pastes the unit ID, sees a live countdown, pays and burns it in one transaction |
| `src/lib/gonka.ts` | Sends the custody timeline to **two** Gonka-hosted models in parallel via `api/gonka.ts`, reports agreement/disagreement + a combined risk score + per-model Gonka Request IDs |
| `src/lib/chainAnalysis.ts` | Zero-cost local checks (timing gaps, skipped steps, duplicate scans) that run before *and independently of* the AI call, so the demo never goes blank on bad wifi |
| `api/gonka.ts` | Server-side proxy to `api.gonkarouter.io` — required because that API sends no CORS headers (a browser cannot call it directly) and because the API key must never ship inside client-bundled code |

## Setup

### 0. Install the Sui CLI (one-time)

On Windows, the fastest path is the prebuilt binary — no Rust/Cargo needed:

```powershell
# Download the testnet-matching release, extract it, add to PATH
$dir = "$env:USERPROFILE\sui-cli"
New-Item -ItemType Directory -Force -Path $dir
Invoke-WebRequest -Uri "https://github.com/MystenLabs/sui/releases/download/testnet-v1.78.1/sui-testnet-v1.78.1-windows-x86_64.tgz" -OutFile "$dir\sui.tgz"
tar -xzf "$dir\sui.tgz" -C $dir
[Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));$dir", "User")
```

Open a **new** terminal after this so the PATH change takes effect, then confirm with `sui --version`. On macOS/Linux, use the matching release asset from the [Sui releases page](https://github.com/MystenLabs/sui/releases) instead.

### 1. Deploy the contract (testnet)

```bash
cd contract
sui client switch --env testnet
sui client faucet          # or the web faucet if this is rate-limited: https://faucet.sui.io
sui move test              # 18 tests should pass
sui client publish --gas-budget 200000000
```

Copy the **Package ID** from the "Published Objects" section of the output.

> If you change any existing `struct`'s fields later (not just add new functions), Sui will refuse an `upgrade` — you'll need `sui client publish` again for a fresh package ID, which orphans any batches/units created under the old one. Adding new functions/structs only *is* upgrade-compatible (`sui client upgrade --gas-budget 200000000`).

### 2. Configure the frontend

```bash
cd frontend
npm install
cp .env.example .env
```

Edit `.env`:

```bash
VITE_SUI_NETWORK=testnet
VITE_PACKAGE_ID=<the package id you just published>

# NOT VITE_-prefixed on purpose — these stay server-side (read by api/gonka.ts
# in production, and by the Vite dev-server proxy in vite.config.ts locally).
# A VITE_ prefix would ship the key inside the client JS bundle.
GONKA_BASE_URL=https://api.gonkarouter.io/v1
GONKA_API_KEY=<your Gonka Router API key>

# Model IDs aren't secret, so these stay client-side.
VITE_GONKA_MODEL_A=MiniMaxAI/MiniMax-M2.7
VITE_GONKA_MODEL_B=moonshotai/Kimi-K2.6
```

### 3. Wallet setup

Install a Sui wallet browser extension (Sui Wallet or Slush), switch its network to **testnet**, and fund it with testnet SUI — either the in-wallet faucet button, or `https://faucet.sui.io` with your address pasted in. **The address that needs SUI is the one connected in your wallet extension**, which is not automatically the same as your `sui client active-address` — check both if a transaction fails with "No valid gas coins found."

### 4. Run it

```bash
npm run dev
```

Open the printed `localhost` URL, connect your wallet, and you're ready to go through the flow below.

## How to use each tab

1. **Register batch** (manufacturer) — enter a batch code + product name, sign. You get a QR encoding a public verify link, and can immediately generate a sheet of individually-numbered per-item QR codes to print.
2. **Scan checkpoint** (distributor/pharmacy) — paste or scan a batch ID, pick a role, add a location/note, sign. Blocked while the batch is on hold.
3. **Verify a product** (anyone, no wallet needed) — paste/scan a batch ID (or a printed item QR, which shows its package number too). Shows the full checkpoint ledger and hold history. From here, a `RegulatorCap` holder can place/release holds, and anyone can run the AI check or generate more item QR codes.
4. **Create sale QR** (pharmacy) — paste a batch ID and set a price in SUI. Generates a QR that's valid for exactly 10 minutes and exactly one payment. Mint this at the register, not in advance — a long-lived unpaid QR sitting on a shelf is easy to photograph and clone; a code that only exists for one checkout isn't.
5. **Pay & dispense** (customer) — scan/paste a unit ID, see the live price and countdown, pay. The object is deleted the instant payment succeeds — scanning the same QR again correctly shows "already paid for and burned," even for the person who just paid.

## Testing

```bash
cd contract && sui move test          # 14 unit tests, covers happy paths + every abort condition
cd frontend && npx tsc --noEmit       # typecheck
cd frontend && npm run build          # full production build
```

Manual end-to-end smoke test (needs a funded testnet wallet): register a batch → add a checkpoint → place a hold → release it → mint a sale QR → pay it → confirm the same unit ID now shows as burned → generate + print a few item QR codes and scan one back in.

## Deploying the live demo (Vercel)

`api/gonka.ts` is a Vercel serverless function, so this deploys as a normal Vite project with zero extra config on Vercel — just make sure to set `GONKA_API_KEY` and `GONKA_BASE_URL` as **environment variables in the Vercel project settings**, not in a committed file. `.env` is gitignored and is not used in production; Vercel functions read `process.env` directly from what you configure in its dashboard.

## Design decisions worth knowing

- **Single-use QR = object deletion, not a flag.** `purchase_and_burn` deletes the `Unit` object outright. A flag-based "already sold" check can have race conditions or be bypassed by a bug; an object that's been deleted from chain state cannot be referenced by any future transaction, full stop.
- **10-minute expiry on sale QRs.** Mitigates (doesn't eliminate) the obvious attack on any printed/displayed QR: a counterfeiter photographing it and racing to redeem it before the real buyer does. Minting at the point of sale rather than pre-printing weeks in advance shrinks the window this attack has to work in.
- **Mandatory severity + case reference + release note on holds.** A hold with no classification, no external case to cross-reference, and no stated reason for lifting it isn't an audit record — it's a flag that got flipped twice. All three are required inputs, not optional metadata.
- **No access control on `add_checkpoint`.** Deliberate MVP simplification: trust comes from every checkpoint being permanently and publicly attributed to a real wallet address, not from an allow-list. Placing/releasing holds *is* capability-gated (`RegulatorCap`), since that's a much stronger action that freezes the whole chain.
- **AI check degrades gracefully.** Local rule-based checks (`chainAnalysis.ts`) run first and independently of the Gonka call, so a flaky connection during a demo still shows *something* instead of a blank error.

## Known limitations / good next steps

- **No cold-chain data.** The AI only reasons over timing/sequence, not sensor data (e.g. temperature excursions). Adding a `temperature_c` field to `Checkpoint` plus a rule in `chainAnalysis.ts` is a small extension.
- **No hidden/scratch-off secret on sale QRs.** The 10-minute expiry mitigates cloning but doesn't eliminate it; a commit-reveal scheme (a hidden code under a scratch panel, hashed on-chain) would close that further at the cost of more physical packaging complexity.
- **Single demo dataset.** There's no real pharmacy registry to cross-reference — the AI reasons over the custody *pattern*, not a live drugs database. Be upfront about that in a pitch.
