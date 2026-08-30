# PharmaTrust — On-Chain Pharmaceutical Custody & Anti-Counterfeit Register

A Sui + AI project built for a hackathon, targeting:

- **Sui Track 02 — AI × Sui** (primary): on-chain ownership/custody, payments, and AI-driven verification in one product.
- **Gonka "AI for Society"** (secondary submission): the AI cross-check below satisfies Gonka Router's full mandatory checklist — multi-model consensus, a Truth-Score-equivalent, a reasoning trail, and visible Gonka Request IDs.

**The pitch in one line:** blockchain proves custody, single-use QR codes prove a sale can't be double-charged or replayed, and independent AI models catch what looks cloned or tampered.

## What it does

1. A listed manufacturer registers a drug **batch** on Sui — a shared object every later party can attach to, with an expiry date set at registration. Only addresses in the `ManufacturerRegistry` allow-list can do this, so "manufacturer" is a vetted claim, not just whoever signed the transaction. Once a batch's expiry passes, `mint_unit`/`purchase_and_burn` both refuse it — expired stock stops being sellable automatically, the same way a hold does.
2. Distributors/pharmacies add **checkpoints** as the batch physically moves — permanently attributed to whoever's wallet signed it, no way to forge who touched it. A checkpoint can optionally record a **temperature reading**, and the AI/local checks flag any reading outside the 2-8°C cold-chain band.
3. A listed regulator can **place a hold** (with a severity level, a category, a case reference, and — on release — a mandatory explanation) to freeze the custody chain during an investigation or recall. A hold doesn't just freeze paperwork: it blocks new sale QRs from being minted *and* blocks payment on ones already minted, so a recalled batch can't keep selling on a technicality. **Critical** holds go further — releasing one requires two different regulators (propose + confirm), not a single signer. Regulator access itself is a revocable allow-list (`RegulatorRegistry`), not a bearer capability object — an admin can actually cut off a compromised or ex-employee's access, not just supersede it while the old grant stays valid forever.
4. Anyone can **verify** a batch with no wallet at all, see its full history (including any temperature readings, flagged red if outside the 2-8°C cold-chain range), and run a live **AI cross-check**: two independent models (via Gonka Router) reason over the custody timeline in parallel and flag impossible timing, skipped steps, duplicate scans, or a cold-chain excursion. A separate **Active Holds** dashboard lists every batch currently on hold anywhere in the system — a public recall registry, not a per-batch lookup tool — built entirely from on-chain hold events, paginated up to 4,000 events deep rather than only the most recent page.
5. A pharmacy can **mint a single-use sale QR** at checkout; a customer scans and **pays** in the same transaction — the on-chain object is deleted the instant it's paid, so the exact same QR can never be charged twice, and it expires after 10 minutes if unused. Redeeming it also requires a **scratch-off secret code**, printed separately from the QR and never stored on-chain in the clear (only its SHA-256 hash is) — a photo of the QR alone is not enough to redeem it.
6. A manufacturer/pharmacy can **generate and print** a batch of individually-numbered verify QR codes — one per physical package — for labeling a real print run.
7. Every on-chain action surfaces as a toast notification with a clickable Sui Explorer link for the transaction; every address/object-ID/digest shown anywhere in the app has a one-click copy button. A top-level error boundary catches any unexpected crash (like the `VITE_SUI_NETWORK` misconfiguration that once white-screened the whole app) and shows a recoverable error screen instead of a blank page.

## Repo layout

```
contract/                     Sui Move package (the on-chain half)
  sources/pharma_track.move   Batch, Checkpoint, HoldRecord, AdminCap, RegulatorRegistry, ManufacturerRegistry, Unit
  tests/pharma_track_tests.move  35 unit tests (test with `sui move test`)
  Move.toml / Published.toml

frontend/                     React + Vite app (the off-chain half)
  api/gonka.ts                 Vercel serverless function — proxies Gonka Router calls server-side
  vite.config.ts                Mirrors api/gonka.ts as a dev-server middleware for local testing
  src/
    lib/                       network config, Sui object parsing, Gonka integration, rule-based checks, QR helpers, hold-event aggregation, allow-list hooks, toast state, Explorer URL helpers
    components/                Register / Scan / Verify / Mint / Pay / Active-Holds screens, QR generation + scanning, hold controls, admin panels, AI report panel, error boundary, copy-able code chips
```

## What each piece does

| Piece | Role |
|---|---|
| `Batch` (Move) | Shared object created by `create_batch`; carries an `expiry_ms` set at registration; accumulates `Checkpoint`s via `add_checkpoint` (no access gate on checkpoints — trust comes from public attribution, not permissioning). A `Checkpoint` can optionally carry a temperature reading — Move has no signed integers, so it's stored as an unsigned offset (`TEMPERATURE_OFFSET_C = 200`) and un-offset on read |
| `Unit.secret_hash` (Move) | `mint_unit` takes a SHA-256 hash of a randomly-generated scratch code, not the code itself; `purchase_and_burn` takes the raw code and re-hashes it on-chain to check a match (commit-reveal) — the secret is never stored on-chain in the clear, and a photo of the printed QR alone (which only encodes the `Unit` object ID) can't be redeemed without also having the separately-printed scratch code |
| `AdminCap` + `RegulatorRegistry` + `ManufacturerRegistry` (Move) | Both registries are shared allow-lists (`VecSet<address>`) — `RegulatorRegistry` gates who can place/release holds, `ManufacturerRegistry` gates who can call `create_batch` — checked by address, not by object possession. One `AdminCap` (minted once at publish) manages both via `admin_add_regulator`/`admin_revoke_regulator` and `admin_add_manufacturer`/`admin_revoke_manufacturer`. This replaced an earlier bearer-capability design specifically because a capability object can never be taken back once handed out; an allow-list can |
| Hold system | `place_hold` requires a severity (Advisory / Recall / Critical), a category (Counterfeit / Quality Defect / Labeling Error / Cold-Chain Breach / Other), a mandatory case reference, and freezes `add_checkpoint`, `mint_unit`, and `purchase_and_burn`. `release_hold` requires a mandatory release note; **Critical** holds reject `release_hold` outright and require `propose_release` + `confirm_release` from two *different* listed regulators. Every cycle is kept forever in `hold_history`, even after release, including who proposed vs. who confirmed |
| `Unit` (Move) | A single-use, shared "sale ticket" for one physical package. `mint_unit` creates it with a price and a 10-minute expiry (aborts if the batch is held or already expired); `purchase_and_burn` takes the `Batch` too, re-checks it isn't held or expired *at redemption time* (not just at mint time), takes exact payment, forwards it to the manufacturer, and **deletes the object** — the QR pointing at it becomes permanently unredeemable, which is what makes it single-use (not a flag that could be bypassed, an object that stops existing) |
| Register tab | Listed manufacturer calls `create_batch` with an expiry date; also generates the printable per-item verify QR sheet; an "Admin: manage manufacturer access" panel appears for the `AdminCap` holder |
| Scan tab | Distributor/pharmacy calls `add_checkpoint` |
| Verify tab | Public, no wallet needed — reads the object straight from Sui, shows the ledger + hold history + expiry status, runs the AI check, and can also generate item QR codes for an existing batch. Scanning a printed item QR (with a serial) whose batch is currently held shows a loud "do not use this medicine" banner, even though that specific package's QR was printed before the hold existed |
| Active Holds tab | Public, no wallet needed — a recall registry listing every batch currently on hold system-wide, reconstructed from `BatchHeld`/`BatchReleased` events rather than requiring a known batch ID |
| Create sale QR tab | Pharmacy calls `mint_unit` at checkout; disabled with a clear warning if the batch is on hold or expired |
| Pay & dispense tab | Customer scans/pastes the unit ID, sees a live countdown, pays and burns it in one transaction; disabled with a clear warning if the batch has gone on hold or expired since the QR was minted |
| `src/lib/gonka.ts` | Sends the custody timeline to **two** Gonka-hosted models in parallel via `api/gonka.ts`, reports agreement/disagreement + a combined risk score + per-model Gonka Request IDs |
| `src/lib/chainAnalysis.ts` | Zero-cost local checks (timing gaps, skipped steps, duplicate scans) that run before *and independently of* the AI call, so the demo never goes blank on bad wifi |
| `src/lib/activeHolds.ts` | Reconstructs which batches are currently held by diffing `BatchHeld`/`BatchReleased` event pages client-side — no on-chain index of "current holds" exists, so this is computed each time the dashboard loads. `fetchAllEvents` follows `queryEvents`'s cursor up to 20 pages (4,000 events) deep instead of reading only the first page |
| `src/lib/secret.ts` | Generates a random scratch code, and hashes it (Web Crypto `SHA-256`) both for the on-chain commit at mint time and for a fast client-side pre-check at redemption time before ever building a transaction |
| `src/lib/registry.ts` | `useIsListed` / `useAdminCap` hooks shared by both registries — reads a `VecSet<address>` field directly rather than calling into Move for what's just a field read |
| `src/lib/toast.tsx` | App-wide toast notifications for transaction outcomes, replacing the inline `success-banner`/`error-text` paragraphs that used to linger in forms after the user moved on; inline text is still used for pre-flight field validation, which belongs next to the field |
| `src/lib/explorer.ts` | Builds Suiscan URLs for transactions/objects/addresses — every digest and code chip in the app links out to a real block explorer instead of dead-ending as plain text |
| `src/components/CodeChip.tsx` | One address/object-ID/digest display component with a copy button and optional Explorer link, used everywhere instead of the old plain unclickable `<span>` |
| `src/components/ErrorBoundary.tsx` | Wraps the whole app (outside `SuiClientProvider`) so a crash there shows a recoverable error screen instead of a blank page — added directly in response to the `VITE_SUI_NETWORK` incident |
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
sui move test              # 33 tests should pass
sui client publish --gas-budget 200000000
```

Copy the **Package ID** from the "Published Objects" section of the output, and both shared registry object IDs from "Created Objects" (types `...::batch::RegulatorRegistry` and `...::batch::ManufacturerRegistry`, both `Owner: Shared`) — unlike the package ID, a shared object's ID isn't derivable from anything else, it only appears in this output.

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
VITE_MANUFACTURER_REGISTRY_OBJECT_ID=<the ManufacturerRegistry object id from the same publish>

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

1. **Register batch** (listed manufacturer) — enter a batch code, product name, and expiry date, sign. You get a QR encoding a public verify link, and can immediately generate a sheet of individually-numbered per-item QR codes to print. If the connected wallet holds the `AdminCap`, an "Admin: manage manufacturer access" panel appears — add or revoke a manufacturer address here.
2. **Scan checkpoint** (distributor/pharmacy) — paste or scan a batch ID, pick a role, add a location/note, sign. Optionally check "Temperature measured" and enter a reading if this is a cold-chain shipment. Blocked while the batch is on hold.
3. **Verify a product** (anyone, no wallet needed) — paste/scan a batch ID (or a printed item QR, which shows its package number too). Shows the full checkpoint ledger, hold history, and expiry (with a warning banner inside a 60-day "expires soon" window, and a hard stop once actually expired). From here, a listed regulator can place/release holds, and anyone can run the AI check or generate more item QR codes.
   - Placing a **Critical** hold and later releasing it needs two people: one regulator clicks "Propose release" with a note, then a *different* one clicks "Confirm release" — the UI blocks the same wallet from doing both.
   - A hold sitting active past a severity-scaled threshold (1 day for Critical, 7 for Recall, 30 for Advisory) shows an "⏰ Overdue for review" badge — a UI nudge only, nothing on-chain enforces a deadline.
   - If the connected wallet holds the `AdminCap`, an "Admin: manage regulator access" panel appears — add or revoke a regulator address here.
4. **Active Holds** (anyone, no wallet needed) — every batch currently on hold, anywhere in the system, in one list. Click "View batch" to jump straight to that batch's Verify page.
5. **Create sale QR** (pharmacy) — paste a batch ID and set a price in SUI. Generates a QR that's valid for exactly 10 minutes and exactly one payment, plus a **separate scratch code** — hand the QR and the code to the buyer through different channels (e.g. the QR printed on the receipt, the code read aloud or on a separate slip). Mint this at the register, not in advance — a long-lived unpaid QR sitting on a shelf is easy to photograph and clone; a code that only exists for one checkout isn't, and even a photographed QR is useless without the scratch code. Blocked if the batch is on hold or expired.
6. **Pay & dispense** (customer) — scan/paste a unit ID, enter the scratch code given separately, see the live price and countdown, pay. A wrong code fails fast with a clear message before any transaction is built. The object is deleted the instant payment succeeds — scanning the same QR again correctly shows "already paid for and burned," even for the person who just paid. Blocked if the batch has gone on hold or expired since the QR was minted.

Every signed transaction above shows a toast notification (success or error) instead of leaving stale text sitting in the form, and every address/object-ID/transaction-digest chip throughout the app has a copy button and links out to Suiscan.

## Testing

```bash
cd contract && sui move test          # 35 unit tests, covers happy paths + every abort condition
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
- **Allow-list over bearer capability for regulator/manufacturer access.** An earlier version gated holds with a `RegulatorCap` object — mint one, anyone holding it can act, forever. The problem: there's no way to *revoke* a capability object once it's in someone's wallet; minting a replacement doesn't invalidate the old one. Switching to address allow-lists (`RegulatorRegistry`/`ManufacturerRegistry`, checked by `ctx.sender()` membership) plus one `AdminCap` that manages *both lists* means access can actually be cut off. The `AdminCap` itself is still a bearer object with no revocation path — a real deployment would want a backup admin or multisig for it.
- **`create_batch` is gated the same way holds are.** Without a `ManufacturerRegistry`, "manufacturer" on a `Batch` is just whoever happened to sign the registration transaction — anyone could call `create_batch` and claim to be any manufacturer. Gating it by the same allow-list pattern as regulators closes that without introducing a second access-control design to reason about.
- **Expiry blocks sales the same way a hold does.** `mint_unit`/`purchase_and_burn` both check `expiry_ms`, mirroring the existing `is_held` checks exactly — an expired batch is treated as a stoppage, not a warning label, for the same reason a held one is. Unlike a hold, though, expiry is never reversible by anyone; it's a fact about the physical product's shelf life, not a decision that gets walked back.
- **Structured hold categories alongside severity.** Severity (Advisory/Recall/Critical) says how urgent a hold is; category (Counterfeit/Quality Defect/Labeling Error/Cold-Chain Breach/Other) says what kind of problem it is. Keeping both as fixed taxonomies, separate from the free-text `reason`, is what makes holds filterable and reportable instead of every regulator inventing their own wording for the same underlying problem.
- **A public Active Holds dashboard, not just per-batch lookup.** A hold that only surfaces when someone already knows to check a specific batch ID isn't a functioning recall notice. Building the dashboard from `BatchHeld`/`BatchReleased` events (rather than needing a registry of every `Batch` object ID) means it works without any index beyond what's already public on-chain. It follows `queryEvents`'s pagination cursor up to 4,000 events deep rather than reading only the first page, which would silently miss any older still-active hold.
- **Cold-chain temperature as an unsigned offset.** Move has no signed integer type, so a `Checkpoint`'s optional temperature is stored as `temperature_c_offset: u64` (actual °C + a fixed 200 offset) rather than trying to represent negative Celsius values directly; both the contract and frontend un-offset it back to a real, possibly-negative °C on read.
- **Scratch-off secret as a commit-reveal hash, not a second QR.** `mint_unit` stores only `sha2_256(secret)` on-chain; `purchase_and_burn` takes the raw secret and re-hashes it to check a match. This is what makes a photographed sale QR alone insufficient to redeem — the object ID it encodes is public the moment it's minted, but the secret needed to actually pay against it is never written anywhere on-chain in the clear, and is meant to reach the buyer through a separate channel from the QR itself.
- **AI check degrades gracefully.** Local rule-based checks (`chainAnalysis.ts`) run first and independently of the Gonka call, so a flaky connection during a demo still shows *something* instead of a blank error.
- **A top-level error boundary, added after a real incident.** `VITE_SUI_NETWORK` set to an invalid value once white-screened the entire live deployment with nothing but a console error — confirmed live on 2026-08-29. `ErrorBoundary` wraps the app outside `SuiClientProvider`/`WalletProvider` specifically so a crash in *those* providers (not just in a leaf component) still shows a recoverable screen instead of a blank page.
- **Toasts for transaction outcomes, inline text for field validation.** These are different kinds of feedback with different lifetimes: a transaction result is transient and shouldn't linger in the form after the user has moved on to something else, while "this field is required" belongs right next to the field it's about, for as long as the field is wrong. Conflating the two into one `error`/`success` state per form (the old pattern) meant stale success banners sitting in forms indefinitely.

## Known limitations / good next steps

- **Cold-chain temperature is self-reported, not sensor-verified.** Whoever records a checkpoint types in the temperature by hand — there's no IoT sensor attestation behind it, so a dishonest actor can simply not report an excursion (or report a fake in-range value) rather than being caught by the system. It still catches honest mistakes and makes dishonesty an active, attributable choice rather than a silent gap.
- **Scratch code closes cloning for the QR image, not for a leaked code.** If someone obtains *both* the QR and the scratch code (e.g. a dishonest pharmacy employee, or a customer who photographs the receipt with the code visible), the mitigation doesn't help — it specifically defeats cloning a photo of the QR alone, since object IDs are inherently public the moment a `Unit` is minted.
- **Single demo dataset.** There's no real pharmacy registry to cross-reference — the AI reasons over the custody *pattern*, not a live drugs database. Be upfront about that in a pitch.
- **Stale-hold flagging is UI-only.** The "⏰ Overdue for review" badge is computed client-side against wall-clock time; nothing on-chain enforces a review deadline or auto-escalates a stuck hold. A real version might auto-escalate an unaddressed Critical hold's case reference to a wider regulator list after N hours.
- **No hidden per-item on-chain state.** The recall warning on a scanned item QR works because the Verify page re-reads the *batch's* current hold status every time — there's no separate on-chain record of "which specific printed QR codes exist," so this cascades correctly by construction rather than needing an explicit notification step, but it also means there's no way to notify someone proactively; they have to re-scan to see the warning.
- **Active Holds dashboard still has a (much higher) event ceiling.** Pagination now follows up to 4,000 hold/release events (20 pages of 200) instead of just the first 200, but an extremely long-running deployment could still exceed that. A production version would maintain an actual on-chain/indexed registry of current holds instead of refetching the full event history on every load.
- **Not yet responsive on mobile.** Layout assumes a desktop-width viewport (fixed-width QR grids, side-by-side `field-row` forms, no small-screen breakpoints) — a real deployment where pharmacists/customers scan QR codes with a phone needs this fixed before it's actually usable in the field.
- **`AdminCap` itself has no revocation path.** It controls who's in both registries, but losing it (or it leaking) means nobody can ever change either list again — a real deployment would want a backup admin, a timelock, or a multisig here rather than a single bearer object.
- **Near-expiry warning threshold (60 days) is a fixed UI constant.** It isn't configurable per product, and — like the stale-hold badge — enforces nothing on-chain; it's purely a heads-up computed against wall-clock time at render.
