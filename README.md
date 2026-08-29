# PharmaTrust — On-Chain Pharmaceutical Custody & Anti-Counterfeit Register

A Sui + AI project built for a hackathon, targeting:

- **Sui Track 02 — AI × Sui** (primary): on-chain ownership/custody, payments, and AI-driven verification in one product.
- **Gonka "AI for Society"** (secondary submission): the AI cross-check below satisfies Gonka Router's full mandatory checklist — multi-model consensus, a Truth-Score-equivalent, a reasoning trail, and visible Gonka Request IDs.

**The pitch in one line:** blockchain proves custody, single-use QR codes prove a sale can't be double-charged or replayed, and independent AI models catch what looks cloned or tampered.

## What it does

1. A manufacturer registers a drug **batch** on Sui — a shared object every later party can attach to.
2. Distributors/pharmacies add **checkpoints** as the batch physically moves — permanently attributed to whoever's wallet signed it, no way to forge who touched it.
3. A listed regulator can **place a hold** (with a severity level, a category, a case reference, and — on release — a mandatory explanation) to freeze the custody chain during an investigation or recall. A hold doesn't just freeze paperwork: it blocks new sale QRs from being minted *and* blocks payment on ones already minted, so a recalled batch can't keep selling on a technicality. **Critical** holds go further — releasing one requires two different regulators (propose + confirm), not a single signer. Regulator access itself is a revocable allow-list (`RegulatorRegistry`), not a bearer capability object — an admin can actually cut off a compromised or ex-employee's access, not just supersede it while the old grant stays valid forever.
4. Anyone can **verify** a batch with no wallet at all, see its full history, and run a live **AI cross-check**: two independent models (via Gonka Router) reason over the custody timeline in parallel and flag impossible timing, skipped steps, or duplicate scans. A separate **Active Holds** dashboard lists every batch currently on hold anywhere in the system — a public recall registry, not a per-batch lookup tool — built entirely from on-chain hold events.
5. A pharmacy can **mint a single-use sale QR** at checkout; a customer scans and **pays** in the same transaction — the on-chain object is deleted the instant it's paid, so the exact same QR can never be charged twice, and it expires after 10 minutes if unused.
6. A manufacturer/pharmacy can **generate and print** a batch of individually-numbered verify QR codes — one per physical package — for labeling a real print run.

## Repo layout

```
contract/                     Sui Move package (the on-chain half)
  sources/pharma_track.move   Batch, Checkpoint, HoldRecord, AdminCap, RegulatorRegistry, Unit
  tests/pharma_track_tests.move  27 unit tests (test with `sui move test`)
  Move.toml / Published.toml

frontend/                     React + Vite app (the off-chain half)
  api/gonka.ts                 Vercel serverless function — proxies Gonka Router calls server-side
  vite.config.ts                Mirrors api/gonka.ts as a dev-server middleware for local testing
  src/
    lib/                       network config, Sui object parsing, Gonka integration, rule-based checks, QR helpers, hold-event aggregation
    components/                Register / Scan / Verify / Mint / Pay / Active-Holds screens, QR generation + scanning, hold controls, AI report panel
```

## What each piece does

| Piece | Role |
|---|---|
| `Batch` (Move) | Shared object created by `create_batch`; accumulates `Checkpoint`s via `add_checkpoint` (no access gate — trust comes from public attribution, not permissioning) |
| `AdminCap` + `RegulatorRegistry` (Move) | `RegulatorRegistry` is a shared allow-list (`VecSet<address>`) of who can place/release holds — checked by address, not by object possession. The `AdminCap` holder (minted once at publish) can `admin_add_regulator` / `admin_revoke_regulator`. This replaced an earlier bearer-capability design specifically because a capability object can never be taken back once handed out; an allow-list can |
| Hold system | `place_hold` requires a severity (Advisory / Recall / Critical), a category (Counterfeit / Quality Defect / Labeling Error / Cold-Chain Breach / Other), a mandatory case reference, and freezes `add_checkpoint`, `mint_unit`, and `purchase_and_burn`. `release_hold` requires a mandatory release note; **Critical** holds reject `release_hold` outright and require `propose_release` + `confirm_release` from two *different* listed regulators. Every cycle is kept forever in `hold_history`, even after release, including who proposed vs. who confirmed |
| `Unit` (Move) | A single-use, shared "sale ticket" for one physical package. `mint_unit` creates it with a price and a 10-minute expiry (aborts if the batch is held); `purchase_and_burn` takes the `Batch` too, re-checks it isn't held *at redemption time* (not just at mint time), takes exact payment, forwards it to the manufacturer, and **deletes the object** — the QR pointing at it becomes permanently unredeemable, which is what makes it single-use (not a flag that could be bypassed, an object that stops existing) |
| Register tab | Manufacturer calls `create_batch`; also generates the printable per-item verify QR sheet |
| Scan tab | Distributor/pharmacy calls `add_checkpoint` |
| Verify tab | Public, no wallet needed — reads the object straight from Sui, shows the ledger + hold history, runs the AI check, and can also generate item QR codes for an existing batch. Scanning a printed item QR (with a serial) whose batch is currently held shows a loud "do not use this medicine" banner, even though that specific package's QR was printed before the hold existed |
| Active Holds tab | Public, no wallet needed — a recall registry listing every batch currently on hold system-wide, reconstructed from `BatchHeld`/`BatchReleased` events rather than requiring a known batch ID |
| Create sale QR tab | Pharmacy calls `mint_unit` at checkout; disabled with a clear warning if the batch is on hold |
| Pay & dispense tab | Customer scans/pastes the unit ID, sees a live countdown, pays and burns it in one transaction; disabled with a clear warning if the batch has gone on hold since the QR was minted |
| `src/lib/gonka.ts` | Sends the custody timeline to **two** Gonka-hosted models in parallel via `api/gonka.ts`, reports agreement/disagreement + a combined risk score + per-model Gonka Request IDs |
| `src/lib/chainAnalysis.ts` | Zero-cost local checks (timing gaps, skipped steps, duplicate scans) that run before *and independently of* the AI call, so the demo never goes blank on bad wifi |
| `src/lib/activeHolds.ts` | Reconstructs which batches are currently held by diffing `BatchHeld`/`BatchReleased` event pages client-side — no on-chain index of "current holds" exists, so this is computed each time the dashboard loads |
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
sui move test              # 27 tests should pass
sui client publish --gas-budget 200000000
```

Copy the **Package ID** from the "Published Objects" section of the output, and the **`RegulatorRegistry` object ID** from "Created Objects" (type `...::batch::RegulatorRegistry`, `Owner: Shared`) — unlike the package ID, a shared object's ID isn't derivable from anything else, it only appears in this output.

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
VITE_REGISTRY_OBJECT_ID=<the RegulatorRegistry object id from the same publish>

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
3. **Verify a product** (anyone, no wallet needed) — paste/scan a batch ID (or a printed item QR, which shows its package number too). Shows the full checkpoint ledger and hold history. From here, a listed regulator can place/release holds, and anyone can run the AI check or generate more item QR codes.
   - Placing a **Critical** hold and later releasing it needs two people: one regulator clicks "Propose release" with a note, then a *different* one clicks "Confirm release" — the UI blocks the same wallet from doing both.
   - A hold sitting active past a severity-scaled threshold (1 day for Critical, 7 for Recall, 30 for Advisory) shows an "⏰ Overdue for review" badge — a UI nudge only, nothing on-chain enforces a deadline.
   - If the connected wallet holds the `AdminCap`, an "Admin: manage regulator access" panel appears — add or revoke a regulator address here.
4. **Active Holds** (anyone, no wallet needed) — every batch currently on hold, anywhere in the system, in one list. Click "View batch" to jump straight to that batch's Verify page.
5. **Create sale QR** (pharmacy) — paste a batch ID and set a price in SUI. Generates a QR that's valid for exactly 10 minutes and exactly one payment. Mint this at the register, not in advance — a long-lived unpaid QR sitting on a shelf is easy to photograph and clone; a code that only exists for one checkout isn't. Blocked if the batch is on hold.
6. **Pay & dispense** (customer) — scan/paste a unit ID, see the live price and countdown, pay. The object is deleted the instant payment succeeds — scanning the same QR again correctly shows "already paid for and burned," even for the person who just paid. Blocked if the batch has gone on hold since the QR was minted.

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
- **A hold blocks sales, not just custody.** Without this, a batch could be placed under a "Critical — stop sale" hold and someone could still mint and sell a `Unit` against it seconds later. `mint_unit` checks at mint time; `purchase_and_burn` checks again at redemption time, because a batch can go on hold in the window between the two.
- **Critical holds need two different signers to release.** One person can place a critical hold alone (pulling the emergency brake shouldn't require consensus), but releasing one requires `propose_release` from one `RegulatorCap` holder and `confirm_release` from a *different* one — mirrors how real recalls aren't unilateral decisions. Advisory/Recall holds stay single-signer, since requiring two people for every minor hold would just create friction without a matching real-world norm.
- **No access control on `add_checkpoint`.** Deliberate MVP simplification: trust comes from every checkpoint being permanently and publicly attributed to a real wallet address, not from an allow-list. Placing/releasing holds *is* access-gated, via `RegulatorRegistry`, since that's a much stronger action that freezes the whole chain and blocks sales.
- **Allow-list over bearer capability for regulator access.** An earlier version gated holds with a `RegulatorCap` object — mint one, anyone holding it can act, forever. The problem: there's no way to *revoke* a capability object once it's in someone's wallet; minting a replacement doesn't invalidate the old one. Switching to an address allow-list (`RegulatorRegistry`, checked by `ctx.sender()` membership) plus a separate `AdminCap` that manages *that list* means access can actually be cut off. The `AdminCap` itself is still a bearer object with no revocation path — a real deployment would want a backup admin or multisig for it.
- **Structured hold categories alongside severity.** Severity (Advisory/Recall/Critical) says how urgent a hold is; category (Counterfeit/Quality Defect/Labeling Error/Cold-Chain Breach/Other) says what kind of problem it is. Keeping both as fixed taxonomies, separate from the free-text `reason`, is what makes holds filterable and reportable instead of every regulator inventing their own wording for the same underlying problem.
- **A public Active Holds dashboard, not just per-batch lookup.** A hold that only surfaces when someone already knows to check a specific batch ID isn't a functioning recall notice. Building the dashboard from `BatchHeld`/`BatchReleased` events (rather than needing a registry of every `Batch` object ID) means it works without any index beyond what's already public on-chain.
- **AI check degrades gracefully.** Local rule-based checks (`chainAnalysis.ts`) run first and independently of the Gonka call, so a flaky connection during a demo still shows *something* instead of a blank error.

## Known limitations / good next steps

- **No cold-chain data.** The AI only reasons over timing/sequence, not sensor data (e.g. temperature excursions). Adding a `temperature_c` field to `Checkpoint` plus a rule in `chainAnalysis.ts` is a small extension.
- **No hidden/scratch-off secret on sale QRs.** The 10-minute expiry mitigates cloning but doesn't eliminate it; a commit-reveal scheme (a hidden code under a scratch panel, hashed on-chain) would close that further at the cost of more physical packaging complexity.
- **Single demo dataset.** There's no real pharmacy registry to cross-reference — the AI reasons over the custody *pattern*, not a live drugs database. Be upfront about that in a pitch.
- **Stale-hold flagging is UI-only.** The "⏰ Overdue for review" badge is computed client-side against wall-clock time; nothing on-chain enforces a review deadline or auto-escalates a stuck hold. A real version might auto-escalate an unaddressed Critical hold's case reference to a wider regulator list after N hours.
- **No hidden per-item on-chain state.** The recall warning on a scanned item QR works because the Verify page re-reads the *batch's* current hold status every time — there's no separate on-chain record of "which specific printed QR codes exist," so this cascades correctly by construction rather than needing an explicit notification step, but it also means there's no way to notify someone proactively; they have to re-scan to see the warning.
- **Active Holds dashboard only sees the most recent 200 hold events.** It doesn't paginate further back, so a hold placed early enough to fall off that window won't appear even if it's still active. Fine for a demo dataset; a production version would paginate `queryEvents` properly or maintain an actual on-chain/indexed registry of current holds.
- **`AdminCap` itself has no revocation path.** It controls who's in the `RegulatorRegistry`, but losing it (or it leaking) means nobody can ever change that list again — a real deployment would want a backup admin, a timelock, or a multisig here rather than a single bearer object.
