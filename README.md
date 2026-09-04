# PharmaTrust — On-Chain Pharmaceutical Custody & Anti-Counterfeit Register

A Sui + AI project built for a hackathon, targeting:

- **Sui Track 02 — AI × Sui** (primary): on-chain ownership/custody, payments, and AI-driven verification in one product.
- **Gonka "AI for Society"** (secondary submission): the AI cross-check below satisfies Gonka Router's full mandatory checklist — multi-model consensus, a Truth-Score-equivalent, a reasoning trail, and visible Gonka Request IDs.

**The pitch in one line:** blockchain proves custody, single-use QR codes prove a sale can't be double-charged or replayed, and independent AI models catch what looks cloned or tampered.

**No wallet is locked out of anything.** Every entry function — registering a batch, minting a sale QR, placing a hold, confirming a suspicion report — is callable by any connected wallet, with no allow-list or admin approval step anywhere. An earlier version gated these behind per-role registries (manufacturer/pharmacy/regulator/admin); that closed real impersonation gaps, but also meant a fresh wallet couldn't do anything until an existing admin added it, which is the wrong tradeoff for something anyone should be able to pick up and try immediately. See "Design decisions" below for the actual tradeoff this makes.

## What it does

1. Anyone can register a drug **batch** on Sui — a shared object every later party can attach to, with an expiry date set at registration. `manufacturer` is simply whoever signs the transaction, not a vetted claim. Once a batch's expiry passes, `mint_unit`/`purchase_and_burn` both refuse it — expired stock stops being sellable automatically, the same way a hold does. The manufacturer can optionally **stake SUI** at registration (and top it up later via `add_stake`) as collateral, locked for the batch's whole shelf life — a hold slashes some or all of it to whoever placed it (100% for Critical + Counterfeit, 50% for a Critical Quality Defect or Cold-Chain Breach, 25% for a Recall + Counterfeit), scaled to how serious the finding actually is rather than all-or-nothing.
2. Anyone add **checkpoints** as the batch physically moves — permanently attributed to whoever's wallet signed it, no way to forge who touched it. A checkpoint can optionally record a **temperature reading**, and the AI/local checks flag any reading outside the 2-8°C cold-chain band.
3. Anyone can **place a hold** (with a severity level, a category, a case reference, and — on release — a mandatory explanation) to freeze the custody chain during an investigation or recall. A hold doesn't just freeze paperwork: it blocks new sale QRs from being minted *and* blocks payment on ones already minted, so a recalled batch can't keep selling on a technicality. **Critical** holds go further — releasing one requires two different addresses (propose + confirm), not a single signer. A hold that sits unaddressed past a severity-scaled review window (1 day Critical / 7 days Recall / 30 days Advisory) can be **flagged as overdue on-chain** by anyone, permanently, via `escalate_stale_hold` — not just a client-side badge that disappears if nobody happens to load the page.
4. Anyone can **verify** a batch with no wallet at all, see its full history (including any temperature readings, flagged red if outside the 2-8°C cold-chain range), and run a live **AI cross-check**: two independent models (via Gonka Router) reason over the custody timeline in parallel and flag impossible timing, skipped steps, duplicate scans, or a cold-chain excursion. A second **cross-batch AI check** reasons over *every* batch from the same manufacturer at once, catching patterns invisible to a single batch — the same actor address touching an implausible number of batches, or repeated counterfeit findings across a manufacturer's history. Anyone can also **report a batch as suspicious** for a bonded amount of at least 0.01 SUI — a permissionless public tip distinct from a hold, refunded if someone confirms it or forfeited to them if rejected as spam, visible right on the Verify page. A separate **Active Holds** dashboard lists every batch currently on hold anywhere in the system — a public recall registry, not a per-batch lookup tool — built entirely from on-chain hold events, paginated up to 4,000 events deep rather than only the most recent page. A **Stats** dashboard summarizes system-wide activity (batches, checkpoints, sales, holds, reports, staked/slashed SUI) computed entirely from public events.
5. Anyone can **mint a single-use sale QR** at checkout; a customer scans and **pays** in the same transaction — the on-chain object is deleted the instant it's paid, so the exact same QR can never be charged twice, and it expires after 10 minutes if unused. Redeeming it also requires a **scratch-off secret code**, printed separately from the QR and never stored on-chain in the clear (only its SHA-256 hash is) — a photo of the QR alone is not enough to redeem it.
6. A manufacturer/pharmacy can **generate and print** a batch of individually-numbered verify QR codes — one per physical package — for labeling a real print run.
7. Every on-chain action surfaces as a toast notification with a clickable Sui Explorer link for the transaction; every address/object-ID/digest shown anywhere in the app has a one-click copy button. A top-level error boundary catches any unexpected crash (like the `VITE_SUI_NETWORK` misconfiguration that once white-screened the whole app) and shows a recoverable error screen instead of a blank page.
8. The layout is responsive down to phone-width viewports — the tab rail scrolls horizontally instead of wrapping badly, the header stacks vertically, and panels/forms reflow to a single column, since pharmacists and customers scanning QR codes in the field are on phones, not desktops.
9. A "📱 Open on phone" button in the header shows a QR of the current page URL, so anyone can pick up the exact page they're looking at on a phone instantly and connect through their wallet app's built-in browser from there — there's no universal deep-link protocol across Sui wallet apps to jump straight into signing, so this solves the more general "get the right page onto a phone fast" problem instead.
10. Every tab except the default one is code-split with `React.lazy` — a first-time visitor only downloads what the Register tab needs, not the QR-scanning, AI, or event-aggregation code behind every other tab, until they actually open it.

## Repo layout

```
contract/                     Sui Move package (the on-chain half)
  sources/pharma_track.move   Batch (with stake collateral), Checkpoint, HoldRecord, Unit, SuspicionReport — no registries, no admin role
  tests/pharma_track_tests.move  47 unit tests (test with `sui move test`)
  Move.toml / Published.toml

frontend/                     React + Vite app (the off-chain half)
  api/gonka.ts                 Vercel serverless function — proxies Gonka Router calls server-side
  vite.config.ts                Mirrors api/gonka.ts as a dev-server middleware for local testing
  src/
    lib/                       network config, Sui object parsing, Gonka integration (single- and cross-batch), rule-based checks, QR helpers, event aggregation, toast state, Explorer URL helpers
    components/                Register / Scan / Verify / Mint / Pay / Active-Holds / Stats screens, QR generation + scanning, hold controls, stake + suspicion-report panels, AI report panels, error boundary, copy-able code chips
```

## What each piece does

| Piece | Role |
|---|---|
| `Batch` (Move) | Shared object created by `create_batch`; carries an `expiry_ms` set at registration; accumulates `Checkpoint`s via `add_checkpoint`. No access gate on any of it — trust comes from public, permanent attribution to whoever signed each transaction, not from permissioning |
| `Unit.secret_hash` (Move) | `mint_unit` takes a SHA-256 hash of a randomly-generated scratch code, not the code itself; `purchase_and_burn` takes the raw code and re-hashes it on-chain to check a match (commit-reveal) — the secret is never stored on-chain in the clear, and a photo of the printed QR alone (which only encodes the `Unit` object ID) can't be redeemed without also having the separately-printed scratch code |
| Hold system | `place_hold` requires a severity (Advisory / Recall / Critical), a category (Counterfeit / Quality Defect / Labeling Error / Cold-Chain Breach / Other), a mandatory case reference, and freezes `add_checkpoint`, `mint_unit`, and `purchase_and_burn`. `release_hold` requires a mandatory release note; **Critical** holds reject `release_hold` outright and require `propose_release` + `confirm_release` from two *different* addresses. `escalate_stale_hold` — callable by anyone — permanently flags a hold that's sat past its severity-scaled review window, without releasing it or changing what it blocks. Every cycle is kept forever in `hold_history`, even after release, including who proposed vs. who confirmed and whether it was ever escalated |
| `Unit` (Move) | A single-use, shared "sale ticket" for one physical package. `mint_unit` creates it with a price and a 10-minute expiry (aborts if the batch is held or already expired); `purchase_and_burn` takes the `Batch` too, re-checks it isn't held or expired *at redemption time* (not just at mint time), takes exact payment, forwards it to the manufacturer, and **deletes the object** — the QR pointing at it becomes permanently unredeemable, which is what makes it single-use (not a flag that could be bypassed, an object that stops existing) |
| `Batch.stake` (Move) | Optional `Balance<SUI>` collateral posted at `create_batch`, locked for the batch's whole shelf life. `add_stake` lets the manufacturer top it up any time before expiry (while not held); `place_hold` slashes some or all of it to whoever placed the hold via `slash_percent` — 100% for Critical + Counterfeit, 50% for a Critical Quality Defect/Cold-Chain Breach, 25% for a Recall + Counterfeit, 0% otherwise — as a paid bounty, not a treasury burn; `withdraw_stake` lets the manufacturer reclaim whatever's left, but only once `expiry_ms` has passed and the batch isn't currently held |
| `SuspicionReport` (Move) | A shared object created by `report_suspicion` (permissionless, same trust model as `add_checkpoint`), holding a bonded `Coin<SUI>` of at least `MIN_SUSPICION_BOND` (0.01 SUI) from the reporter — a bond of any positive size is technically nonzero, but a 1-MIST bond is spam with extra steps, so this floor makes the deterrent real. Anyone can later call `confirm_suspicion` (bond refunded) or `reject_suspicion` (bond forfeited to them) to consume it |
| Register tab | Any connected wallet calls `create_batch` with an expiry date and an optional SUI stake; also generates the printable per-item verify QR sheet |
| Scan tab | Any connected wallet calls `add_checkpoint` |
| Verify tab | Public, no wallet needed — reads the object straight from Sui, shows the ledger + hold history + expiry + stake status, runs the single-batch and cross-batch AI checks, lists/accepts/confirms/rejects suspicion reports, and can also generate item QR codes for an existing batch. Scanning a printed item QR (with a serial) whose batch is currently held shows a loud "do not use this medicine" banner, even though that specific package's QR was printed before the hold existed |
| Active Holds tab | Public, no wallet needed — a recall registry listing every batch currently on hold system-wide, reconstructed from `BatchHeld`/`BatchReleased` events rather than requiring a known batch ID |
| Stats tab | Public, no wallet needed — system-wide counts (batches, checkpoints, sales, holds, reports, staked/slashed/withdrawn SUI) computed by reading every relevant event type once and summarizing client-side |
| Create sale QR tab | Any connected wallet calls `mint_unit` at checkout; disabled with a clear warning if the batch is on hold or expired |
| Pay & dispense tab | Customer scans/pastes the unit ID, sees a live countdown, pays and burns it in one transaction; disabled with a clear warning if the batch has gone on hold or expired since the QR was minted |
| `src/lib/gonka.ts` | `checkAnomaly` sends one batch's custody timeline to **two** Gonka-hosted models in parallel via `api/gonka.ts`; `checkCrossBatchAnomaly` sends *every* batch from one manufacturer together instead, for patterns a single-batch prompt can't see. Both report agreement/disagreement + a combined risk score + per-model Gonka Request IDs |
| `src/components/CrossBatchPanel.tsx` | Fetches every sibling batch's object by chunking IDs into groups of 50 before calling `multiGetObjects` (Sui's JSON-RPC caps a single call at 50 IDs) — a manufacturer with any number of registered batches gets compared in full, not just the first 50 |
| `src/lib/chainAnalysis.ts` | `analyzeChain` runs zero-cost local checks (timing gaps, skipped steps, duplicate scans, cold-chain excursions) on one batch; `analyzeCrossBatch` runs cross-batch rules (one actor touching many batches, repeated counterfeit findings) — both run before *and independently of* their respective AI calls, so the demo never goes blank on bad wifi |
| `src/lib/activeHolds.ts` | `computeActiveHolds` reconstructs which batches are currently held by diffing `BatchHeld`/`BatchReleased` event pages client-side — no on-chain index of "current holds" exists, so this is computed each time the dashboard loads. `fetchAllEvents` follows `queryEvents`'s cursor up to 20 pages (4,000 events) deep instead of reading only the first page, and is reused by the Stats and suspicion-report panels for the same reason |
| `src/lib/secret.ts` | Generates a random scratch code, and hashes it (Web Crypto `SHA-256`) both for the on-chain commit at mint time and for a fast client-side pre-check at redemption time before ever building a transaction |
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
sui move test              # 47 tests should pass
sui client publish --gas-budget 200000000
```

Copy the **Package ID** from the "Published Objects" section of the output — that's the only ID you need. There's no `init` function and no shared registries to seed, since the contract has no access control.

> If you change any existing `struct`'s fields or function signatures later, Sui will refuse an `upgrade` — you'll need `sui client publish` again for a fresh package ID, which orphans any batches/units created under the old one. Adding new functions/structs only *is* upgrade-compatible (`sui client upgrade --gas-budget 200000000`), but see the design-decision note below about events before relying on that.

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

1. **Register batch** (anyone) — enter a batch code, product name, expiry date, and an optional SUI stake, sign. You get a QR encoding a public verify link, and can immediately generate a sheet of individually-numbered per-item QR codes to print.
2. **Scan checkpoint** (anyone) — paste or scan a batch ID, pick a role, add a location/note, sign. Optionally check "Temperature measured" and enter a reading if this is a cold-chain shipment. Blocked while the batch is on hold.
3. **Verify a product** (anyone, no wallet needed) — paste/scan a batch ID (or a printed item QR, which shows its package number too). Shows the full checkpoint ledger, hold history, and expiry (with a warning banner inside a 60-day "expires soon" window, and a hard stop once actually expired). From here, anyone can place/release holds, or run the AI check or generate more item QR codes.
   - Placing a **Critical** hold and later releasing it needs two people: one address clicks "Propose release" with a note, then a *different* one clicks "Confirm release" — the UI blocks the same wallet from doing both.
   - A hold sitting active past a severity-scaled threshold (1 day for Critical, 7 for Recall, 30 for Advisory) shows an "⏰ Overdue for review" badge. Anyone can click "Flag as overdue (on-chain)" to make that permanent and public via `escalate_stale_hold` — after that it shows as "🚨 Escalated" instead, a fact recorded in `hold_history`, not just something the UI computed this one time.
   - A stake panel shows how much is locked (even at 0), and the manufacturer can add more collateral any time before expiry, or withdraw it once the batch has expired with no counterfeit hold and isn't currently held.
   - Anyone can submit a suspicion report with a short note and a small SUI bond, and see every report already submitted for this batch. Anyone can confirm an open report (bond refunded to the reporter) or reject it as spam (bond forfeited to whoever rejected it).
   - "Check this manufacturer's other batches" runs a second AI check across every batch from the same manufacturer, looking for patterns a single-batch review can't see.
4. **Active Holds** (anyone, no wallet needed) — every batch currently on hold, anywhere in the system, in one list. Click "View batch" to jump straight to that batch's Verify page.
5. **Stats** (anyone, no wallet needed) — system-wide counts: batches registered, checkpoints recorded, sale QRs minted/sold, holds placed/released/currently active, average time-to-release, suspicion reports, and total staked/slashed/withdrawn SUI.
6. **Create sale QR** (anyone) — paste a batch ID and set a price in SUI. Generates a QR that's valid for exactly 10 minutes and exactly one payment, plus a **separate scratch code** — hand the QR and the code to the buyer through different channels (e.g. the QR printed on the receipt, the code read aloud or on a separate slip). Mint this at the register, not in advance — a long-lived unpaid QR sitting on a shelf is easy to photograph and clone; a code that only exists for one checkout isn't, and even a photographed QR is useless without the scratch code. Blocked if the batch is on hold or expired.
7. **Pay & dispense** (customer) — scan/paste a unit ID, enter the scratch code given separately, see the live price and countdown, pay. A wrong code fails fast with a clear message before any transaction is built. The object is deleted the instant payment succeeds — scanning the same QR again correctly shows "already paid for and burned," even for the person who just paid. Blocked if the batch has gone on hold or expired since the QR was minted.

The "📱 Open on phone" button in the header (next to Connect Wallet) shows a QR of whatever page you're currently on, for picking it up on a phone instantly.

Every signed transaction above shows a toast notification (success or error) instead of leaving stale text sitting in the form, and every address/object-ID/transaction-digest chip throughout the app has a copy button and links out to Suiscan.

## Testing

```bash
cd contract && sui move test          # 47 unit tests, covers happy paths + every abort condition
cd frontend && npx tsc --noEmit       # typecheck
cd frontend && npm run build          # full production build
```

Manual end-to-end smoke test (needs a funded testnet wallet): register a batch → add a checkpoint → place a hold → release it → mint a sale QR → pay it → confirm the same unit ID now shows as burned → generate + print a few item QR codes and scan one back in.

## Deploying the live demo (Vercel)

`api/gonka.ts` is a Vercel serverless function, so this deploys as a normal Vite project with zero extra config on Vercel — just make sure to set `GONKA_API_KEY` and `GONKA_BASE_URL` as **environment variables in the Vercel project settings**, not in a committed file. `.env` is gitignored and is not used in production; Vercel functions read `process.env` directly from what you configure in its dashboard.

## Design decisions worth knowing

- **No access control anywhere in the contract — a deliberate, explicit tradeoff.** An earlier version gated `create_batch`/`mint_unit`/holds behind `ManufacturerRegistry`/`PharmacyRegistry`/`RegulatorRegistry` allow-lists managed by an `AdminRegistry`, closing real impersonation gaps (anyone could otherwise call `create_batch` and claim to be any manufacturer). That was removed: a fresh wallet being locked out of every action until an existing admin explicitly approved it is the wrong tradeoff for a demo/hackathon build anyone should be able to pick up and use immediately, and it also meant the *first* deployer's admin key was a permanent single point of failure for the whole system. The trust model now is "every action is publicly and permanently attributed to whoever signed it," which is good enough to make bad actors accountable after the fact, not to prevent someone from falsely claiming a role up front. Reintroducing allow-lists (the pattern used in an earlier revision, recoverable from git history) is the natural next step for a production deployment that needs real role verification.
- **Single-use QR = object deletion, not a flag.** `purchase_and_burn` deletes the `Unit` object outright. A flag-based "already sold" check can have race conditions or be bypassed by a bug; an object that's been deleted from chain state cannot be referenced by any future transaction, full stop.
- **10-minute expiry on sale QRs.** Mitigates (doesn't eliminate) the obvious attack on any printed/displayed QR: a counterfeiter photographing it and racing to redeem it before the real buyer does. Minting at the point of sale rather than pre-printing weeks in advance shrinks the window this attack has to work in.
- **Mandatory severity + case reference + release note on holds.** A hold with no classification, no external case to cross-reference, and no stated reason for lifting it isn't an audit record — it's a flag that got flipped twice. All three are required inputs, not optional metadata.
- **A hold blocks sales, not just custody.** Without this, a batch could be placed under a "Critical — stop sale" hold and someone could still mint and sell a `Unit` against it seconds later. `mint_unit` checks at mint time; `purchase_and_burn` checks again at redemption time, because a batch can go on hold in the window between the two.
- **Critical holds need two different signers to release.** One person can place a critical hold alone (pulling the emergency brake shouldn't require consensus), but releasing one requires `propose_release` from one address and `confirm_release` from a *different* one — mirrors how real recalls aren't unilateral decisions, and is independent of registry membership since there is none. Advisory/Recall holds stay single-signer, since requiring two people for every minor hold would just create friction without a matching real-world norm.
- **Stale-hold escalation is permissionless, same reasoning as everything else.** `escalate_stale_hold` only turns an already-public, independently-computable fact ("this hold has been open longer than its review window") into a permanent on-chain record and event. Restricting who can flag that would just add friction to something anyone can already verify by reading `held_at_ms` and the current clock themselves.
- **Expiry blocks sales the same way a hold does.** `mint_unit`/`purchase_and_burn` both check `expiry_ms`, mirroring the existing `is_held` checks exactly — an expired batch is treated as a stoppage, not a warning label, for the same reason a held one is. Unlike a hold, though, expiry is never reversible by anyone; it's a fact about the physical product's shelf life, not a decision that gets walked back.
- **Structured hold categories alongside severity.** Severity (Advisory/Recall/Critical) says how urgent a hold is; category (Counterfeit/Quality Defect/Labeling Error/Cold-Chain Breach/Other) says what kind of problem it is. Keeping both as fixed taxonomies, separate from the free-text `reason`, is what makes holds filterable and reportable instead of every reporter inventing their own wording for the same underlying problem.
- **A public Active Holds dashboard, not just per-batch lookup.** A hold that only surfaces when someone already knows to check a specific batch ID isn't a functioning recall notice. Building the dashboard from `BatchHeld`/`BatchReleased` events (rather than needing a registry of every `Batch` object ID) means it works without any index beyond what's already public on-chain. It follows `queryEvents`'s pagination cursor up to 4,000 events deep rather than reading only the first page, which would silently miss any older still-active hold.
- **Cold-chain temperature as an unsigned offset.** Move has no signed integer type, so a `Checkpoint`'s optional temperature is stored as `temperature_c_offset: u64` (actual °C + a fixed 200 offset) rather than trying to represent negative Celsius values directly; both the contract and frontend un-offset it back to a real, possibly-negative °C on read.
- **Scratch-off secret as a commit-reveal hash, not a second QR.** `mint_unit` stores only `sha2_256(secret)` on-chain; `purchase_and_burn` takes the raw secret and re-hashes it to check a match. This is what makes a photographed sale QR alone insufficient to redeem — the object ID it encodes is public the moment it's minted, but the secret needed to actually pay against it is never written anywhere on-chain in the clear, and is meant to reach the buyer through a separate channel from the QR itself.
- **AI check degrades gracefully.** Local rule-based checks (`chainAnalysis.ts`) run first and independently of the Gonka call, so a flaky connection during a demo still shows *something* instead of a blank error.
- **A top-level error boundary, added after a real incident.** `VITE_SUI_NETWORK` set to an invalid value once white-screened the entire live deployment with nothing but a console error — confirmed live on 2026-08-29. `ErrorBoundary` wraps the app outside `SuiClientProvider`/`WalletProvider` specifically so a crash in *those* providers (not just in a leaf component) still shows a recoverable screen instead of a blank page.
- **Stake slashing is graduated, not all-or-nothing.** `slash_percent` scales the cut to how serious the finding actually is: 100% for a confirmed Critical + Counterfeit hold, 50% for a Critical Quality Defect or Cold-Chain Breach (real manufacturer fault, but not fraud), 25% for a Recall + Counterfeit (defined but less urgent), 0% for everything else. A flat all-or-nothing slash either over-punishes a lesser finding or under-punishes a confirmed one; scaling it means the financial consequence actually tracks the severity of what was found.
- **Stake is slashed as a bounty, not burned.** Sending the slashed amount to whoever placed the hold (rather than burning it or routing it to a treasury) turns catching counterfeits into something with a direct financial reward, not just unpaid diligence.
- **Stake stays locked for the whole shelf life, not until the manufacturer wants it back.** `withdraw_stake` requires `clock.timestamp_ms() >= expiry_ms`. Without that, a manufacturer could stake a token amount, withdraw it immediately, and let a counterfeiting problem surface only after the money is already back in their wallet — defeating the entire point of collateral.
- **`add_stake` exists because collateral needs a way to grow, not just shrink.** A manufacturer who registered without staking (or staked too little) had no path to strengthen their bond later — only `withdraw_stake` existed, one-directional. `add_stake` mirrors `withdraw_stake`'s guardrails (must be this batch's manufacturer, blocked while held or expired) so a top-up can't be timed to make a batch look freshly collateralized mid-investigation, but otherwise just joins the payment into `Batch.stake`.
- **Suspicion reports are bonded, not free — and the bond has a real floor.** `report_suspicion` requires a `Coin<SUI>` bond of at least `MIN_SUSPICION_BOND` (0.01 SUI), held in a shared `SuspicionReport` object until confirmed (bond refunded) or rejected (bond forfeited to whoever rejected it, compensating their time reviewing something that turned out to be noise). A merely-nonzero bond (an earlier design) technically deters *free* spam, but a 1-MIST bond is spam with extra steps; a real floor is what makes the deterrent a genuine cost.
- **A lesson learned along the way: `sui client upgrade` is compatible, but events aren't upgrade-stable.** A prior change (the minimum-bond floor) only tightened an assert inside an existing function — no struct or signature changes — so it looked like a textbook case for `sui client upgrade` instead of a fresh publish. Testing it live showed the catch: every event's `packageId` (and therefore its `MoveEventType`) switches to the *new* package address after an upgrade, while everything emitted before the upgrade keeps the old address. Every event-driven feature here (Active Holds, Stats, suspicion-report listing, cross-batch lookup) filters by one fixed `PACKAGE_ID`, so an upgrade would have made all of them silently blind to pre-upgrade history. This project sticks to fresh publishes specifically to keep one package ID as the single source of truth for the whole event log, at the cost of orphaning existing batches/units on every change.
- **Cross-batch AI check is a separate call, not a bigger single-batch prompt.** `checkCrossBatchAnomaly` reasons over every batch from one manufacturer at once specifically because some patterns (one actor's address touching an implausible number of a manufacturer's batches, repeated counterfeit findings across separate incidents) are structurally invisible to a prompt scoped to a single batch — no amount of a single-batch model "trying harder" can see across batches it never received.
- **Stats dashboard reads events, not a maintained counter.** No entry function increments an on-chain "total batches" field — every number is recomputed from the same public event log the Active Holds dashboard and suspicion-report panel already read, so there's exactly one source of truth (the event log) instead of a counter that could drift from it.
- **A QR of the current URL instead of a fake wallet deep link.** There's no standardized `sui://`-style URI scheme every wallet app honors the way some other ecosystems have; claiming one exists would just produce a button that silently does nothing on most wallets. Scanning a URL into a phone's camera and opening it in a wallet's built-in browser is what actually works today across Slush and Sui Wallet.
- **Toasts for transaction outcomes, inline text for field validation.** These are different kinds of feedback with different lifetimes: a transaction result is transient and shouldn't linger in the form after the user has moved on to something else, while "this field is required" belongs right next to the field it's about, for as long as the field is wrong. Conflating the two into one `error`/`success` state per form (the old pattern) meant stale success banners sitting in forms indefinitely.
- **Cross-batch lookup chunks `multiGetObjects` calls instead of hitting its 50-ID cap.** Sui's JSON-RPC refuses more than 50 object IDs in one `multiGetObjects` call. `CrossBatchPanel` splits the sibling-batch ID list into 50-ID chunks and fetches them in parallel, so a manufacturer with hundreds of batches gets compared in full instead of silently only against the first 50 `queryEvents` happened to return.
- **Every non-default tab is `React.lazy`-loaded.** The production bundle was a single ~1.1MB chunk that Vite explicitly warned about; splitting each tab (and the vendor code it alone depends on — QR scanning, the Gonka/cross-batch AI logic, event-aggregation for Stats/Active-Holds) into its own chunk means a first visit only pays for the Register tab's dependencies, with everything else fetched on demand the moment a tab is actually opened, and cached separately afterward.

## Known limitations / good next steps

- **No role verification at all.** "Manufacturer," "regulator," and "pharmacy" are just labels for whoever happened to sign a given transaction — there's no way to distinguish a real pharmacy from anyone pretending to be one. This is the headline tradeoff of removing all access control (see the design decision above); a production deployment would need to reintroduce some form of vetted allow-list, KYC, or off-chain-attested credential.
- **Anyone can place, confirm, or reject anything.** Holds, suspicion confirmations/rejections, and stake-slashing outcomes all depend on `place_hold`/`confirm_suspicion`/`reject_suspicion` being called by someone acting in good faith — there's no penalty or accountability mechanism beyond public attribution for a bad-faith hold or a wrongly rejected report (a rejecter keeping a bond they weren't owed, for instance).
- **Cold-chain temperature is self-reported, not sensor-verified.** Whoever records a checkpoint types in the temperature by hand — there's no IoT sensor attestation behind it, so a dishonest actor can simply not report an excursion (or report a fake in-range value) rather than being caught by the system. It still catches honest mistakes and makes dishonesty an active, attributable choice rather than a silent gap.
- **Scratch code closes cloning for the QR image, not for a leaked code.** If someone obtains *both* the QR and the scratch code (e.g. a dishonest pharmacy employee, or a customer who photographs the receipt with the code visible), the mitigation doesn't help — it specifically defeats cloning a photo of the QR alone, since object IDs are inherently public the moment a `Unit` is minted.
- **Single demo dataset.** There's no real pharmacy registry to cross-reference — the AI reasons over the custody *pattern*, not a live drugs database. Be upfront about that in a pitch.
- **Stale-hold escalation is a visibility flag, not an auto-release or auto-notify.** `escalate_stale_hold` makes "this has been overdue for a while" a permanent on-chain fact, but nothing pushes that fact to anyone — someone still has to load the Verify page (or query `HoldEscalated` events directly) to see it, and the hold itself doesn't get released or its case reference forwarded anywhere.
- **No hidden per-item on-chain state.** The recall warning on a scanned item QR works because the Verify page re-reads the *batch's* current hold status every time — there's no separate on-chain record of "which specific printed QR codes exist," so this cascades correctly by construction rather than needing an explicit notification step, but it also means there's no way to notify someone proactively; they have to re-scan to see the warning.
- **Active Holds dashboard still has a (much higher) event ceiling.** Pagination now follows up to 4,000 hold/release events (20 pages of 200) instead of just the first 200, but an extremely long-running deployment could still exceed that. A production version would maintain an actual on-chain/indexed registry of current holds instead of refetching the full event history on every load.
- **Mobile layout is functional, not fully optimized.** The tab rail, header, and forms now reflow correctly down to phone-width viewports, but print sheets and dense tables (the QR print grid, the model-verdict comparison) are still tuned primarily for a larger screen — usable on a phone, not necessarily the most comfortable experience there yet.
- **Near-expiry warning threshold (60 days) is a fixed UI constant.** It isn't configurable per product, and — like the stale-hold badge — enforces nothing on-chain; it's purely a heads-up computed against wall-clock time at render.
- **Stake is denominated only in SUI — no multi-token support.** `add_stake` lets a manufacturer top up collateral after registration, but only ever in SUI; a real deployment might want to accept other tokens or a stablecoin.
- **Suspicion bond minimum is a fixed constant, not configurable or scaled.** `MIN_SUSPICION_BOND` (0.01 SUI) is the same for every batch regardless of its stake, price, or perceived risk — a real deployment might want it scaled to, say, a fraction of the batch's stake, so higher-stakes products get a proportionally stronger anti-spam floor.
- **Stats and cross-batch checks re-read the full event history on every load.** Same tradeoff as the Active Holds dashboard: fine for a demo-scale deployment, but a production version would want incremental/indexed reads instead of rescanning everything each time a tab is opened.
- **No universal wallet deep link.** The "Open on phone" QR gets the right page onto a phone, but from there someone still has to manually open it inside their wallet app's browser — there's no one-tap "open Slush and pre-fill this transaction" flow, since no such standard exists across Sui wallets today.
