/// pharma_track::batch
///
/// On-chain chain-of-custody record for a pharmaceutical batch.
///
/// A `Batch` is created once by the manufacturer and shared, so every
/// downstream party (distributor, pharmacy, ...) can attach a `Checkpoint`
/// to it as the physical product moves through the supply chain. The
/// caller's address is taken from the transaction context, so a checkpoint
/// can never be forged as coming from someone else — the worst a bad actor
/// can do is add a checkpoint under their own real address, which is itself
/// useful signal for the anomaly-detection layer running off-chain.
///
/// This module intentionally does NOT gate who may call `add_checkpoint`.
/// For a hackathon MVP the trust model is "every checkpoint is publicly
/// visible and permanently attributed", not "only pre-approved addresses
/// may write". Adding an allow-list (e.g. a `ManufacturerCap` /
/// `DistributorCap` capability object) is a natural next step — see the
/// README for where that would plug in.
///
/// Placing/releasing a hold IS access-gated (unlike `add_checkpoint`): a
/// hold is a much stronger action — it freezes the whole custody chain and
/// blocks sales — so it requires the caller's address to be listed in the
/// shared `RegulatorRegistry`. This is deliberately an address allow-list,
/// not a bearer capability object: a capability object (like the earlier
/// version of this module used) can never be taken back once handed out —
/// whoever holds it holds it forever, even after they leave the job or the
/// key leaks. An allow-list can be revoked. The deployer is seeded as the
/// sole member of a shared `AdminRegistry` at publish time; any listed
/// admin can add or revoke regulator addresses via `admin_add_regulator` /
/// `admin_revoke_regulator`, and can add a backup admin via
/// `admin_add_admin` before ever needing one.
///
/// A hold carries a `severity` classification (`SEVERITY_*`), a `category`
/// classification (`CATEGORY_*`), a mandatory `case_reference` for
/// cross-referencing off-chain paperwork, and — on release — a mandatory
/// `release_note`. None of these are optional metadata: a regulatory hold
/// with no severity, no category, no case to point back to, or no stated
/// reason for lifting it isn't a usable audit record, just a flag that got
/// flipped twice.
///
/// A hold also gates sales, not just custody: `mint_unit` and
/// `purchase_and_burn` both abort while `is_held` is true. Without this, a
/// batch could be placed under a "Critical — stop sale" hold and someone
/// could still mint and sell a `Unit` against it seconds later — the hold
/// would be evidence after the fact, not an actual stoppage.
///
/// `SEVERITY_CRITICAL` holds cannot be released by a single signer.
/// `release_hold` aborts for them; releasing one requires `propose_release`
/// from one regulator followed by `confirm_release` from a *different*
/// one. This mirrors how real recalls work: one person can pull the
/// emergency brake alone, but nobody unilaterally decides a critical
/// stop-sale is over.
///
/// `create_batch` is similarly gated by a `ManufacturerRegistry` (the same
/// allow-list pattern as `RegulatorRegistry`, managed by the same
/// `AdminCap`): without it, anyone could call `create_batch` and claim to
/// be any manufacturer, since `manufacturer` is otherwise just whoever
/// happened to sign the transaction. This closes that gap without
/// changing how the rest of the system already treats `manufacturer` —
/// it's still `ctx.sender()`, just from a sender who's now been vetted.
///
/// Every batch also carries an `expiry_ms` set at registration. Like a
/// hold, expiry gates sales: `mint_unit` and `purchase_and_burn` both
/// abort once the batch has expired, on the same reasoning as the hold
/// checks — expired stock shouldn't be sellable, not just flagged as
/// expired after the fact. Unlike a hold, expiry is never reversible by a
/// regulator action; it's a fact about the physical product, not a
/// decision anyone gets to walk back.
///
/// A `Checkpoint` can optionally carry a temperature reading (`has_temperature`
/// + `temperature_c_offset`, see the constant doc comment for the offset
/// encoding) — cold-chain data for the off-chain anomaly layer to reason
/// over. It's optional because not every custody handoff has a thermometer
/// attached; a `false` doesn't mean "was fine," it means "wasn't measured."
///
/// A `Unit`'s sale QR only encodes its object ID, which is visible the
/// moment it's printed or displayed — anyone who photographs it before the
/// real buyer pays has everything needed to race them to `purchase_and_burn`,
/// same as any barcode. `mint_unit` closes that by also taking a
/// `secret_hash`: a hash of a one-time code that travels through a
/// *separate* channel (told to the buyer verbally, printed on a receipt,
/// under a scratch panel — anything not embedded in the visible QR).
/// `purchase_and_burn` requires the matching preimage, so a cloned QR alone
/// is not sufficient to redeem; the secret is the second factor. This doesn't
/// replace the 10-minute expiry, it stacks with it — expiry bounds how long
/// a leaked secret+QR pair stays dangerous, the secret bounds what a QR-only
/// clone can do at all.
module pharma_track::batch;

use std::hash;
use std::option::{Self, Option};
use std::string::{Self, String};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;
use sui::vec_set::{Self, VecSet};

/// A single custody event in a batch's lifecycle.
public struct Checkpoint has copy, drop, store {
    /// Address that submitted this checkpoint (the tx sender, not user input).
    actor: address,
    /// Free-form role label, e.g. b"manufacturer", b"distributor", b"pharmacy".
    role: String,
    location: String,
    timestamp_ms: u64,
    note: String,
    /// Whether a temperature was measured at this checkpoint at all —
    /// `false` means "not measured," not "was in range."
    has_temperature: bool,
    /// Celsius reading plus `TEMPERATURE_OFFSET_C`, so it can be stored as
    /// a `u64` despite Move having no signed integer type. Meaningless
    /// when `has_temperature` is `false`. Subtract the offset back out to
    /// get the real Celsius value.
    temperature_c_offset: u64,
}

/// One full hold+release cycle. `released_by`/`released_at_ms`/`release_note`
/// are `none` while the hold is still active — this is what makes the
/// record durable: unlike the `is_held`/`hold_reason`/... fields on `Batch`
/// (which only describe the *current* hold and get reset on release), every
/// entry here stays in `hold_history` forever, so a batch that was held and
/// released three times still shows all three as evidence.
public struct HoldRecord has copy, drop, store {
    held_by: address,
    reason: String,
    /// Regulatory severity classification — see the `SEVERITY_*` constants.
    /// Distinguishes "worth a note" from "stop selling this immediately",
    /// which a single free-text reason can't do consistently across
    /// different regulators writing their own wording.
    severity: u8,
    /// What kind of problem this is — see the `CATEGORY_*` constants.
    /// Separate from severity (how urgent) and from the free-text reason
    /// (narrative detail): this is the structured field that makes holds
    /// filterable/reportable instead of every regulator inventing their
    /// own wording for "counterfeit" vs. "labeling error" vs. etc.
    category: u8,
    /// External case/investigation reference (e.g. a regulator's own
    /// ticket number), so this on-chain record can be cross-referenced
    /// against off-chain paperwork instead of standing alone.
    case_reference: String,
    held_at_ms: u64,
    released_by: Option<address>,
    released_at_ms: Option<u64>,
    /// Why it was safe to release — required precisely because "who and
    /// when" without "why" is an audit gap: a hold could otherwise be
    /// lifted with no on-chain justification at all.
    release_note: Option<String>,
    /// Set only when this release went through the two-signer critical
    /// path (`propose_release` + `confirm_release`): the address that
    /// *proposed* the release, distinct from `released_by` (the address
    /// that *confirmed* it). `none` for single-signer releases.
    co_released_by: Option<address>,
    /// Whether this hold cycle was ever flagged by `escalate_stale_hold` as
    /// having sat unaddressed past its review window, before it was
    /// eventually released. Permanent once set — unlike `Batch.hold_escalated`,
    /// this doesn't get reset, since it's a fact about how this particular
    /// cycle played out, not the current state.
    escalated: bool,
}

/// On-chain record for one drug batch.
public struct Batch has key {
    id: UID,
    batch_code: String,
    product_name: String,
    manufacturer: address,
    created_at_ms: u64,
    /// Absolute timestamp (ms) after which this batch can no longer be
    /// sold — set once at registration, never changed afterward.
    expiry_ms: u64,
    checkpoints: vector<Checkpoint>,
    /// True while the batch is under hold (e.g. a suspected counterfeit or
    /// a recall). While held, `add_checkpoint` aborts — the custody chain
    /// is frozen until someone releases the hold.
    is_held: bool,
    hold_reason: String,
    hold_severity: u8,
    hold_category: u8,
    hold_case_reference: String,
    held_by: address,
    held_at_ms: u64,
    /// Every hold+release cycle this batch has ever been through, oldest
    /// first. The currently-active hold (if any) is always the last entry,
    /// with `released_by`/`released_at_ms` still `none`.
    hold_history: vector<HoldRecord>,
    /// Set by `propose_release` while a critical hold's two-signer release
    /// is pending confirmation; cleared by `confirm_release`. `none`
    /// otherwise, including for non-critical holds (which never use this).
    pending_release_by: Option<address>,
    pending_release_note: Option<String>,
    /// Whether the currently-active hold has been flagged, via
    /// `escalate_stale_hold`, as having sat unaddressed past its
    /// severity-scaled review window. Reset to `false` whenever a new hold
    /// is placed or the current one is released.
    hold_escalated: bool,
    /// Manufacturer-posted collateral, put up at registration and locked
    /// for the batch's whole shelf life. `place_hold` slashes it to the
    /// regulator's address the moment anyone places a Critical +
    /// Counterfeit hold; `withdraw_stake` lets the manufacturer reclaim it,
    /// but only after `expiry_ms` has passed with no such hold ever placed.
    /// A manufacturer with nothing at risk has no on-chain cost to cutting
    /// corners — this gives counterfeiting (specifically) a real, forfeitable
    /// financial consequence instead of just a reputational one.
    stake: Balance<SUI>,
}

/// Shared allow-list of addresses that can manage the regulator and
/// manufacturer registries. Replaces an earlier single bearer `AdminCap`
/// object: losing that object (or it leaking) would have permanently
/// locked out every future admin action, with no way to recover. An
/// allow-list lets a backup admin be seeded ahead of time via
/// `admin_add_admin`, and `admin_remove_admin` refuses to remove the last
/// remaining admin (`ECannotRemoveLastAdmin`) so this can't be emptied
/// into the same unrecoverable state it replaces.
public struct AdminRegistry has key {
    id: UID,
    admins: VecSet<address>,
}

/// The shared allow-list of addresses that can place/release holds.
/// Membership is checked by address, not by object possession — that's
/// what makes revocation possible: `admin_revoke_regulator` just removes
/// an entry, no need to claw back an object from someone else's wallet.
public struct RegulatorRegistry has key {
    id: UID,
    regulators: VecSet<address>,
}

/// The shared allow-list of addresses that can call `create_batch`. Same
/// pattern and same `AdminCap` as `RegulatorRegistry` — a separate struct
/// rather than reusing one registry for both roles because a manufacturer
/// and a regulator are different real-world parties with different
/// trust boundaries, even though this MVP happens to seed the deployer
/// into both at publish time.
public struct ManufacturerRegistry has key {
    id: UID,
    manufacturers: VecSet<address>,
}

/// One physical, sellable dose/pack of a batch, represented as its own
/// shared object so it can be individually addressed by a single QR code.
/// A pharmacy mints one `Unit` per physical package it puts on the shelf;
/// the QR printed on that package encodes this object's ID.
///
/// Redeeming a `Unit` (`purchase_and_burn`) consumes it by value and
/// permanently deletes it from chain state. That deletion is what makes
/// the QR "single-use": the object it points to no longer exists, so a
/// second scan has nothing left to call — Sui itself refuses to build a
/// transaction that references a deleted object ID, there is no
/// application-level flag to check or race.
public struct Unit has key {
    id: UID,
    batch_id: address,
    price: u64,
    manufacturer: address,
    minted_at_ms: u64,
    /// SHA-256 hash of a one-time secret that must travel separately from
    /// the visible QR (see the module doc comment). `purchase_and_burn`
    /// checks the preimage against this, not against the `Unit`'s
    /// existence alone.
    secret_hash: vector<u8>,
}

fun init(ctx: &mut TxContext) {
    let sender = ctx.sender();

    let mut admins = vec_set::empty<address>();
    admins.insert(sender);
    transfer::share_object(AdminRegistry { id: object::new(ctx), admins });

    let mut regulators = vec_set::empty<address>();
    regulators.insert(sender);
    transfer::share_object(RegulatorRegistry { id: object::new(ctx), regulators });

    let mut manufacturers = vec_set::empty<address>();
    manufacturers.insert(sender);
    transfer::share_object(ManufacturerRegistry { id: object::new(ctx), manufacturers });
}

#[test_only]
public fun test_init(ctx: &mut TxContext) {
    init(ctx);
}

// ===== Events =====
// The frontend listens to these instead of polling full objects, and the
// public lookup page can replay them to reconstruct history for an object
// even before it reads the object's current fields. `BatchHeld` /
// `BatchReleased` in particular are what the public "Active Holds"
// dashboard is built from — it queries these directly rather than needing
// to already know every Batch object ID in existence.

public struct BatchCreated has copy, drop {
    batch_id: address,
    batch_code: String,
    product_name: String,
    manufacturer: address,
    created_at_ms: u64,
    expiry_ms: u64,
    stake_amount: u64,
}

/// Emitted by `report_suspicion` — a permissionless, public "something
/// looks wrong here" signal from anyone (customer, pharmacist, competitor),
/// distinct from a regulator's `BatchHeld`. Doesn't change any on-chain
/// state by itself; it's a tip, not a verdict. The Verify page surfaces
/// these so a regulator deciding whether to investigate isn't relying on
/// out-of-band channels to hear about a suspicious batch in the first place.
public struct SuspicionReported has copy, drop {
    batch_id: address,
    reporter: address,
    note: String,
    reported_at_ms: u64,
}

/// Emitted by `place_hold` when a Critical + Counterfeit hold slashes the
/// batch's stake to the placing regulator.
public struct StakeSlashed has copy, drop {
    batch_id: address,
    regulator: address,
    amount: u64,
    slashed_at_ms: u64,
}

/// Emitted by `withdraw_stake` once the manufacturer reclaims their
/// collateral after the batch's shelf life ends with no counterfeit hold.
public struct StakeWithdrawn has copy, drop {
    batch_id: address,
    manufacturer: address,
    amount: u64,
    withdrawn_at_ms: u64,
}

public struct CheckpointAdded has copy, drop {
    batch_id: address,
    actor: address,
    role: String,
    location: String,
    timestamp_ms: u64,
    checkpoint_index: u64,
    has_temperature: bool,
    temperature_c_offset: u64,
}

public struct BatchHeld has copy, drop {
    batch_id: address,
    held_by: address,
    reason: String,
    severity: u8,
    category: u8,
    case_reference: String,
    held_at_ms: u64,
}

/// Emitted by `propose_release` — the first of the two signatures a
/// critical hold's release requires.
public struct ReleaseProposed has copy, drop {
    batch_id: address,
    proposed_by: address,
    note: String,
    proposed_at_ms: u64,
}

/// Emitted by `escalate_stale_hold` — a permanent, on-chain record that a
/// hold sat past its severity-scaled review window without being
/// addressed. Doesn't change `is_held`; it's a visibility escalation, not
/// an automatic release.
public struct HoldEscalated has copy, drop {
    batch_id: address,
    severity: u8,
    held_by: address,
    held_at_ms: u64,
    escalated_at_ms: u64,
}

public struct BatchReleased has copy, drop {
    batch_id: address,
    released_by: address,
    /// Set only for a critical hold released via `confirm_release` — the
    /// address that proposed it, distinct from `released_by`.
    co_released_by: Option<address>,
    release_note: String,
    released_at_ms: u64,
}

public struct UnitMinted has copy, drop {
    unit_id: address,
    batch_id: address,
    price: u64,
    minted_at_ms: u64,
}

/// Emitted right before the `Unit` object is deleted — this is the
/// durable record that the sale happened, since the object itself won't
/// exist to query afterwards.
public struct UnitSold has copy, drop {
    unit_id: address,
    batch_id: address,
    buyer: address,
    price: u64,
    sold_at_ms: u64,
}

// ===== Errors =====

const EEmptyBatchCode: u64 = 0;
const EEmptyProductName: u64 = 1;
const EBatchHeld: u64 = 2;
const EBatchNotHeld: u64 = 3;
const EEmptyHoldReason: u64 = 4;
const EZeroPrice: u64 = 5;
const EWrongPayment: u64 = 6;
const EUnitExpired: u64 = 7;
const EInvalidSeverity: u64 = 8;
const EEmptyCaseReference: u64 = 9;
const EEmptyReleaseNote: u64 = 10;
const EUnitBatchMismatch: u64 = 11;
const ECriticalRequiresMultisig: u64 = 12;
const EReleaseAlreadyProposed: u64 = 13;
const ENoReleaseProposed: u64 = 14;
const ESameRegulatorCannotConfirm: u64 = 15;
const ENotRegulator: u64 = 16;
const EAlreadyRegulator: u64 = 17;
const ENotCurrentRegulator: u64 = 18;
const EInvalidCategory: u64 = 19;
const ENotManufacturer: u64 = 20;
const EAlreadyManufacturer: u64 = 21;
const ENotCurrentManufacturer: u64 = 22;
const EInvalidExpiry: u64 = 23;
const EBatchExpired: u64 = 24;
const EInvalidSecretHash: u64 = 25;
const ESecretMismatch: u64 = 26;
const ENotAdmin: u64 = 27;
const EAlreadyAdmin: u64 = 28;
const ENotCurrentAdmin: u64 = 29;
const ECannotRemoveLastAdmin: u64 = 30;
const EHoldAlreadyEscalated: u64 = 31;
const EHoldNotYetOverdue: u64 = 32;
const EEmptySuspicionNote: u64 = 33;
const ENotBatchManufacturer: u64 = 34;
const EStakeLockedUntilExpiry: u64 = 35;
const EStakeAlreadyEmpty: u64 = 36;

/// Hold severity classifications, loosely modeled on how regulators
/// actually grade recalls (e.g. FDA Class I/II/III): the higher the
/// number, the more urgent. Plain `u8` constants rather than a Move enum
/// so `place_hold`'s `severity: u8` parameter stays simple to build from
/// the frontend and to validate with a single range check.
const SEVERITY_ADVISORY: u8 = 1;
const SEVERITY_RECALL: u8 = 2;
const SEVERITY_CRITICAL: u8 = 3;

/// Structured hold categories — what kind of problem this is, orthogonal
/// to severity (how urgent) and to the free-text reason (narrative
/// detail). Fixed taxonomy rather than free text so holds are filterable
/// and reportable instead of every regulator wording the same underlying
/// problem differently.
const CATEGORY_COUNTERFEIT: u8 = 1;
const CATEGORY_QUALITY_DEFECT: u8 = 2;
const CATEGORY_LABELING_ERROR: u8 = 3;
const CATEGORY_COLD_CHAIN_BREACH: u8 = 4;
const CATEGORY_OTHER: u8 = 5;

/// How long a `Unit` stays redeemable after minting, in milliseconds
/// (10 minutes). Short on purpose: a `Unit` is meant to be minted at the
/// register and paid for on the spot, not pre-printed on packaging and
/// left sitting on a shelf for weeks — a long-lived, unpaid QR sitting in
/// public is exactly what's easy to photograph and clone onto counterfeit
/// packaging. Bounding its lifetime bounds that cloning window; it doesn't
/// eliminate it, since anyone can still relay a photo within 10 minutes,
/// but "clone it and race to a till within 10 minutes" is a much smaller
/// attack than "clone it any time before the real one sells." Expiry
/// doesn't refund or reopen a `Unit` — an expired one is simply stuck
/// forever (it can't be re-minted or extended), so the seller mints a
/// fresh one for a new attempt.
const UNIT_EXPIRY_MS: u64 = 600_000;

/// Offset added to a Celsius reading before storing it as `u64` (Move has
/// no signed integer type). 200 covers real-world cold-chain readings
/// (typically -80°C to +50°C) with a lot of headroom; subtract this back
/// out to recover the real Celsius value.
const TEMPERATURE_OFFSET_C: u64 = 200;

/// A `secret_hash` must be exactly a SHA-256 digest's length — this is a
/// sanity check on the input shape, not a guarantee the hash was computed
/// correctly.
const SECRET_HASH_LENGTH: u64 = 32;

/// How long a hold of each severity can sit unaddressed before
/// `escalate_stale_hold` will accept flagging it as overdue — 1 day for
/// Critical, 7 for Recall, 30 for Advisory, mirroring the urgency ordering
/// severity itself encodes. Purely a review deadline, not an auto-release:
/// an overdue hold stays in effect (still blocks sales) exactly as before,
/// this only makes "nobody has looked at this in a while" a permanent,
/// on-chain, publicly-queryable fact instead of something only a UI badge
/// computed against wall-clock time could show.
const CRITICAL_REVIEW_MS: u64 = 86_400_000;
const RECALL_REVIEW_MS: u64 = 604_800_000;
const ADVISORY_REVIEW_MS: u64 = 2_592_000_000;

// ===== Entry functions =====

/// Create a new batch and share it immediately so every later party in the
/// supply chain can attach a checkpoint to the same object. Requires the
/// caller's address to be listed in `registry` — otherwise `manufacturer`
/// would just be a self-declared label, not a vetted claim. `expiry_ms`
/// must be strictly after the registration time; a batch that's already
/// expired the moment it's created isn't a real product.
///
/// `stake_payment` is locked into the batch as collateral for its whole
/// shelf life — see the `Batch.stake` doc comment. Pass a zero-value coin
/// (`coin::zero<SUI>(ctx)`) to register without staking anything; nothing
/// about registration itself requires a nonzero stake, but a batch with no
/// stake also has nothing for `place_hold` to slash on a Critical +
/// Counterfeit finding.
public entry fun create_batch(
    registry: &ManufacturerRegistry,
    batch_code: vector<u8>,
    product_name: vector<u8>,
    expiry_ms: u64,
    stake_payment: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(registry.manufacturers.contains(&sender), ENotManufacturer);
    assert!(batch_code.length() > 0, EEmptyBatchCode);
    assert!(product_name.length() > 0, EEmptyProductName);

    let now = clock.timestamp_ms();
    assert!(expiry_ms > now, EInvalidExpiry);

    let stake = coin::into_balance(stake_payment);
    let stake_amount = stake.value();

    let batch = Batch {
        id: object::new(ctx),
        batch_code: string::utf8(batch_code),
        product_name: string::utf8(product_name),
        manufacturer: sender,
        created_at_ms: now,
        expiry_ms,
        checkpoints: vector::empty<Checkpoint>(),
        is_held: false,
        hold_reason: string::utf8(b""),
        hold_severity: 0,
        hold_category: 0,
        hold_case_reference: string::utf8(b""),
        held_by: @0x0,
        held_at_ms: 0,
        hold_history: vector::empty<HoldRecord>(),
        pending_release_by: option::none(),
        pending_release_note: option::none(),
        hold_escalated: false,
        stake,
    };

    event::emit(BatchCreated {
        batch_id: object::uid_to_address(&batch.id),
        batch_code: batch.batch_code,
        product_name: batch.product_name,
        manufacturer: sender,
        created_at_ms: now,
        expiry_ms,
        stake_amount,
    });

    transfer::share_object(batch);
}

/// Record a custody handoff / scan against an existing shared batch.
/// Anyone can call this — the point of the MVP is that every call is
/// permanently and publicly attributed to `ctx.sender()`, which is what
/// the off-chain anomaly layer reasons over.
///
/// `has_temperature` / `temperature_c_offset` are always both passed (Move
/// entry functions can't take optional arguments) — set `has_temperature`
/// to `false` and `temperature_c_offset` to `0` when this checkpoint has
/// no thermometer reading. See the module doc comment for the offset
/// encoding.
public entry fun add_checkpoint(
    batch: &mut Batch,
    role: vector<u8>,
    location: vector<u8>,
    note: vector<u8>,
    has_temperature: bool,
    temperature_c_offset: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!batch.is_held, EBatchHeld);

    let sender = ctx.sender();
    let now = clock.timestamp_ms();

    let checkpoint = Checkpoint {
        actor: sender,
        role: string::utf8(role),
        location: string::utf8(location),
        timestamp_ms: now,
        note: string::utf8(note),
        has_temperature,
        temperature_c_offset,
    };

    batch.checkpoints.push_back(checkpoint);

    event::emit(CheckpointAdded {
        batch_id: object::uid_to_address(&batch.id),
        actor: sender,
        role: checkpoint.role,
        location: checkpoint.location,
        timestamp_ms: now,
        checkpoint_index: batch.checkpoints.length() - 1,
        has_temperature,
        temperature_c_offset,
    });
}

/// Mint one sellable, single-use `Unit` against a batch. Called by
/// whoever is dispensing the physical package (typically the pharmacy) at
/// the price they're selling it for, in MIST. The returned QR should be
/// printed/shown on that one physical package only — anyone who redeems
/// it via `purchase_and_burn` gets the object deleted out from under any
/// later scan.
///
/// Aborts if the batch is on hold or already expired — a recalled,
/// suspect, or out-of-date batch shouldn't be sellable in the first
/// place, not just flagged after the fact.
///
/// `secret_hash` is the SHA-256 hash of a one-time code that the seller
/// must deliver to the buyer through a channel other than this QR (see
/// the module doc comment) — `purchase_and_burn` requires the matching
/// preimage, so a photograph of just the QR isn't enough to redeem.
public entry fun mint_unit(
    batch: &Batch,
    price: u64,
    secret_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!batch.is_held, EBatchHeld);
    let now = clock.timestamp_ms();
    assert!(now < batch.expiry_ms, EBatchExpired);
    assert!(price > 0, EZeroPrice);
    assert!(secret_hash.length() == SECRET_HASH_LENGTH, EInvalidSecretHash);

    let unit = Unit {
        id: object::new(ctx),
        batch_id: object::uid_to_address(&batch.id),
        price,
        manufacturer: batch.manufacturer,
        minted_at_ms: now,
        secret_hash,
    };

    event::emit(UnitMinted {
        unit_id: object::uid_to_address(&unit.id),
        batch_id: unit.batch_id,
        price,
        minted_at_ms: now,
    });

    transfer::share_object(unit);
}

/// Pay for and burn a `Unit` in one transaction: the buyer's payment goes
/// straight to the batch's manufacturer, and the `Unit` object is deleted
/// so its QR code can never be redeemed again. `payment` must carry the
/// exact price — this MVP doesn't hand back change, so wallets should
/// split an exact-value coin before calling this.
///
/// Takes the `Batch` too and re-checks `is_held` here, not just at mint
/// time: a batch can go on hold in the window between a `Unit` being
/// minted and someone paying for it, and the sale needs to stop the
/// instant that happens, not just block new `Unit`s from then on.
///
/// `secret` must hash (SHA-256) to the `Unit`'s stored `secret_hash` — the
/// buyer needs to have received the one-time code through whatever
/// out-of-band channel the seller used, not just have scanned the visible
/// QR. Wrong or missing secret aborts before any payment moves.
public entry fun purchase_and_burn(
    unit: Unit,
    batch: &Batch,
    payment: Coin<SUI>,
    secret: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(unit.batch_id == object::uid_to_address(&batch.id), EUnitBatchMismatch);
    assert!(!batch.is_held, EBatchHeld);
    assert!(hash::sha2_256(secret) == unit.secret_hash, ESecretMismatch);

    let now = clock.timestamp_ms();
    assert!(now < batch.expiry_ms, EBatchExpired);
    assert!(now - unit.minted_at_ms <= UNIT_EXPIRY_MS, EUnitExpired);
    assert!(coin::value(&payment) == unit.price, EWrongPayment);

    let buyer = ctx.sender();

    event::emit(UnitSold {
        unit_id: object::uid_to_address(&unit.id),
        batch_id: unit.batch_id,
        buyer,
        price: unit.price,
        sold_at_ms: now,
    });

    transfer::public_transfer(payment, unit.manufacturer);

    let Unit { id, batch_id: _, price: _, manufacturer: _, minted_at_ms: _, secret_hash: _ } = unit;
    object::delete(id);
}

/// Place a hold on a batch — freezes the custody chain (no further
/// checkpoints can be added) until someone releases it. Requires the
/// caller's address to be listed in `registry`; the caller's address is
/// also permanently attributed as `held_by` on top of that access check.
///
/// `severity` must be one of the `SEVERITY_*` constants, `category` one
/// of the `CATEGORY_*` constants, and both `reason` and `case_reference`
/// are mandatory — a hold with no classification, no category, or no
/// external case number to cross-reference isn't useful evidence later.
public entry fun place_hold(
    registry: &RegulatorRegistry,
    batch: &mut Batch,
    reason: vector<u8>,
    severity: u8,
    category: u8,
    case_reference: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(registry.regulators.contains(&sender), ENotRegulator);
    assert!(!batch.is_held, EBatchHeld);
    assert!(reason.length() > 0, EEmptyHoldReason);
    assert!(
        severity == SEVERITY_ADVISORY || severity == SEVERITY_RECALL || severity == SEVERITY_CRITICAL,
        EInvalidSeverity,
    );
    assert!(
        category == CATEGORY_COUNTERFEIT
            || category == CATEGORY_QUALITY_DEFECT
            || category == CATEGORY_LABELING_ERROR
            || category == CATEGORY_COLD_CHAIN_BREACH
            || category == CATEGORY_OTHER,
        EInvalidCategory,
    );
    assert!(case_reference.length() > 0, EEmptyCaseReference);

    let now = clock.timestamp_ms();

    batch.is_held = true;
    batch.hold_reason = string::utf8(reason);
    batch.hold_severity = severity;
    batch.hold_category = category;
    batch.hold_case_reference = string::utf8(case_reference);
    batch.held_by = sender;
    batch.held_at_ms = now;
    batch.hold_escalated = false;

    batch.hold_history.push_back(HoldRecord {
        held_by: sender,
        reason: batch.hold_reason,
        severity,
        category,
        case_reference: batch.hold_case_reference,
        held_at_ms: now,
        released_by: option::none(),
        released_at_ms: option::none(),
        release_note: option::none(),
        co_released_by: option::none(),
        escalated: false,
    });

    event::emit(BatchHeld {
        batch_id: object::uid_to_address(&batch.id),
        held_by: sender,
        reason: batch.hold_reason,
        severity,
        category,
        case_reference: batch.hold_case_reference,
        held_at_ms: now,
    });

    // A Critical + Counterfeit finding is the one hold combination with a
    // real financial claim behind it: the manufacturer put up collateral
    // specifically against this outcome. Slashing it to the regulator who
    // caught it (rather than burning it or routing it to a treasury) turns
    // enforcement into a paid bounty, not just unpaid diligence.
    if (severity == SEVERITY_CRITICAL && category == CATEGORY_COUNTERFEIT && batch.stake.value() > 0) {
        let amount = batch.stake.value();
        let slashed = coin::from_balance(batch.stake.withdraw_all(), ctx);
        transfer::public_transfer(slashed, sender);
        event::emit(StakeSlashed {
            batch_id: object::uid_to_address(&batch.id),
            regulator: sender,
            amount,
            slashed_at_ms: now,
        });
    };
}

/// Report a batch as suspicious — a permissionless public tip, distinct
/// from a regulator's `place_hold`. Doesn't freeze anything or require any
/// registry membership; anyone (a customer noticing a mismatched seal, a
/// pharmacist, a competitor) can leave a note. This is intentionally as
/// unrestricted as `add_checkpoint`: the goal is making sure a tip reaches
/// a regulator's attention at all, not gatekeeping who's allowed to raise
/// one — a real recall often starts with exactly this kind of unverified
/// public report.
public entry fun report_suspicion(batch: &Batch, note: vector<u8>, clock: &Clock, ctx: &TxContext) {
    assert!(note.length() > 0, EEmptySuspicionNote);
    event::emit(SuspicionReported {
        batch_id: object::uid_to_address(&batch.id),
        reporter: ctx.sender(),
        note: string::utf8(note),
        reported_at_ms: clock.timestamp_ms(),
    });
}

/// Reclaim the manufacturer's staked collateral once the batch's shelf
/// life is over. Requires the caller to be this specific batch's
/// manufacturer, the batch to not currently be held, and the clock to be
/// past `expiry_ms` — collateral stays locked for the batch's entire
/// active life, not just until the manufacturer feels like withdrawing it,
/// otherwise a manufacturer could unstake early and let a problem surface
/// only after the money's already back in their wallet.
public entry fun withdraw_stake(batch: &mut Batch, clock: &Clock, ctx: &mut TxContext) {
    let sender = ctx.sender();
    assert!(sender == batch.manufacturer, ENotBatchManufacturer);
    assert!(!batch.is_held, EBatchHeld);
    assert!(clock.timestamp_ms() >= batch.expiry_ms, EStakeLockedUntilExpiry);
    let amount = batch.stake.value();
    assert!(amount > 0, EStakeAlreadyEmpty);

    let refund = coin::from_balance(batch.stake.withdraw_all(), ctx);
    transfer::public_transfer(refund, sender);

    event::emit(StakeWithdrawn {
        batch_id: object::uid_to_address(&batch.id),
        manufacturer: sender,
        amount,
        withdrawn_at_ms: clock.timestamp_ms(),
    });
}

/// Release a previously placed hold, unfreezing the custody chain.
/// Requires the caller to be a listed regulator — not necessarily the one
/// that placed the hold, since registry membership is proof of role, not
/// a per-hold ticket. `release_note` is mandatory: "who released it and
/// when" without "why it was safe to" is an audit gap, not a complete
/// record.
///
/// Aborts for `SEVERITY_CRITICAL` holds — those require two different
/// signers via `propose_release` + `confirm_release` instead. See the
/// module doc comment for why.
public entry fun release_hold(
    registry: &RegulatorRegistry,
    batch: &mut Batch,
    release_note: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(registry.regulators.contains(&sender), ENotRegulator);
    assert!(batch.is_held, EBatchNotHeld);
    assert!(batch.hold_severity != SEVERITY_CRITICAL, ECriticalRequiresMultisig);
    assert!(release_note.length() > 0, EEmptyReleaseNote);

    let now = clock.timestamp_ms();
    let note = string::utf8(release_note);

    finish_release(batch, sender, note, option::none(), now);
}

/// First signature of a critical hold's release: records who's proposing
/// it and why, but does NOT unfreeze anything yet — `confirm_release`
/// still has to happen, from a different listed regulator.
public entry fun propose_release(
    registry: &RegulatorRegistry,
    batch: &mut Batch,
    note: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(registry.regulators.contains(&sender), ENotRegulator);
    assert!(batch.is_held, EBatchNotHeld);
    assert!(batch.hold_severity == SEVERITY_CRITICAL, ECriticalRequiresMultisig);
    assert!(batch.pending_release_by.is_none(), EReleaseAlreadyProposed);
    assert!(note.length() > 0, EEmptyReleaseNote);

    let now = clock.timestamp_ms();
    let note_str = string::utf8(note);

    batch.pending_release_by = option::some(sender);
    batch.pending_release_note = option::some(note_str);

    event::emit(ReleaseProposed {
        batch_id: object::uid_to_address(&batch.id),
        proposed_by: sender,
        note: note_str,
        proposed_at_ms: now,
    });
}

/// Second signature of a critical hold's release: must come from a listed
/// regulator other than whoever called `propose_release`. Actually
/// unfreezes the batch, using the note captured at proposal time — the
/// confirming signer is vouching for that stated reason, not writing a
/// new one, since the whole point is two people agreeing on the same
/// justification.
public entry fun confirm_release(
    registry: &RegulatorRegistry,
    batch: &mut Batch,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(registry.regulators.contains(&sender), ENotRegulator);
    assert!(batch.pending_release_by.is_some(), ENoReleaseProposed);

    let proposer = *batch.pending_release_by.borrow();
    assert!(sender != proposer, ESameRegulatorCannotConfirm);

    let note = batch.pending_release_note.extract();
    batch.pending_release_by = option::none();

    let now = clock.timestamp_ms();
    finish_release(batch, sender, note, option::some(proposer), now);
}

/// Flag the currently-active hold as overdue for review, once it has sat
/// unaddressed past its severity-scaled window (`CRITICAL_REVIEW_MS` /
/// `RECALL_REVIEW_MS` / `ADVISORY_REVIEW_MS`). Callable by anyone, same
/// trust model as `add_checkpoint`: this only turns an already-public,
/// independently-computable fact ("this hold has been open longer than
/// its review window") into a permanent on-chain record and event,
/// rather than leaving it as a client-side badge that only shows up if
/// someone happens to load the page. Does not release the hold or change
/// what it blocks — a stale hold stays exactly as blocking as before,
/// just now flagged as overdue.
public entry fun escalate_stale_hold(batch: &mut Batch, clock: &Clock) {
    assert!(batch.is_held, EBatchNotHeld);
    assert!(!batch.hold_escalated, EHoldAlreadyEscalated);

    let now = clock.timestamp_ms();
    let threshold = if (batch.hold_severity == SEVERITY_CRITICAL) {
        CRITICAL_REVIEW_MS
    } else if (batch.hold_severity == SEVERITY_RECALL) {
        RECALL_REVIEW_MS
    } else {
        ADVISORY_REVIEW_MS
    };
    assert!(now - batch.held_at_ms >= threshold, EHoldNotYetOverdue);

    batch.hold_escalated = true;
    let last_index = batch.hold_history.length() - 1;
    let last_record = batch.hold_history.borrow_mut(last_index);
    last_record.escalated = true;

    event::emit(HoldEscalated {
        batch_id: object::uid_to_address(&batch.id),
        severity: batch.hold_severity,
        held_by: batch.held_by,
        held_at_ms: batch.held_at_ms,
        escalated_at_ms: now,
    });
}

/// Shared tail end of releasing a hold — resets the batch's "current
/// hold" fields, closes out the last `hold_history` entry, and emits
/// `BatchReleased`. Used by both the single-signer and two-signer paths
/// so they can never drift out of sync with each other.
fun finish_release(
    batch: &mut Batch,
    released_by: address,
    release_note: String,
    co_released_by: Option<address>,
    now: u64,
) {
    batch.is_held = false;
    batch.hold_reason = string::utf8(b"");
    batch.hold_severity = 0;
    batch.hold_category = 0;
    batch.hold_case_reference = string::utf8(b"");
    batch.held_by = @0x0;
    batch.held_at_ms = 0;
    batch.hold_escalated = false;

    let last_index = batch.hold_history.length() - 1;
    let last_record = batch.hold_history.borrow_mut(last_index);
    last_record.released_by = option::some(released_by);
    last_record.released_at_ms = option::some(now);
    last_record.release_note = option::some(release_note);
    last_record.co_released_by = co_released_by;

    event::emit(BatchReleased {
        batch_id: object::uid_to_address(&batch.id),
        released_by,
        co_released_by,
        release_note,
        released_at_ms: now,
    });
}

/// Onboard another regulator by adding their address to the registry.
/// Caller must be a listed admin in `AdminRegistry` — trust chains back to
/// an existing admin, there is no way to self-add to the registry.
public entry fun admin_add_regulator(
    admin_registry: &AdminRegistry,
    registry: &mut RegulatorRegistry,
    addr: address,
    ctx: &TxContext,
) {
    assert!(admin_registry.admins.contains(&ctx.sender()), ENotAdmin);
    assert!(!registry.regulators.contains(&addr), EAlreadyRegulator);
    registry.regulators.insert(addr);
}

/// Revoke a regulator's access by removing their address from the
/// registry. This is the entire point of the allow-list design over a
/// bearer capability object: a compromised key or an ex-employee's access
/// can actually be cut off, not just superseded by minting more caps
/// while the old one remains forever valid.
public entry fun admin_revoke_regulator(
    admin_registry: &AdminRegistry,
    registry: &mut RegulatorRegistry,
    addr: address,
    ctx: &TxContext,
) {
    assert!(admin_registry.admins.contains(&ctx.sender()), ENotAdmin);
    assert!(registry.regulators.contains(&addr), ENotCurrentRegulator);
    registry.regulators.remove(&addr);
}

/// Onboard a manufacturer by adding their address to `ManufacturerRegistry`.
/// Same `AdminRegistry` as the regulator registry — one admin role governs
/// both allow-lists in this MVP.
public entry fun admin_add_manufacturer(
    admin_registry: &AdminRegistry,
    registry: &mut ManufacturerRegistry,
    addr: address,
    ctx: &TxContext,
) {
    assert!(admin_registry.admins.contains(&ctx.sender()), ENotAdmin);
    assert!(!registry.manufacturers.contains(&addr), EAlreadyManufacturer);
    registry.manufacturers.insert(addr);
}

/// Revoke a manufacturer's ability to register new batches. Existing
/// batches they've already created are unaffected — this only gates
/// future `create_batch` calls, the same way revoking a regulator doesn't
/// undo holds they already placed.
public entry fun admin_revoke_manufacturer(
    admin_registry: &AdminRegistry,
    registry: &mut ManufacturerRegistry,
    addr: address,
    ctx: &TxContext,
) {
    assert!(admin_registry.admins.contains(&ctx.sender()), ENotAdmin);
    assert!(registry.manufacturers.contains(&addr), ENotCurrentManufacturer);
    registry.manufacturers.remove(&addr);
}

/// Add a backup/additional admin to `AdminRegistry`. Caller must already
/// be a listed admin — same trust-chains-back-to-an-existing-member
/// pattern as onboarding a regulator or manufacturer. Seeding a second
/// admin right after publish is exactly what closes the single-point-of-
/// failure gap a lone bearer `AdminCap` used to have.
public entry fun admin_add_admin(
    admin_registry: &mut AdminRegistry,
    addr: address,
    ctx: &TxContext,
) {
    assert!(admin_registry.admins.contains(&ctx.sender()), ENotAdmin);
    assert!(!admin_registry.admins.contains(&addr), EAlreadyAdmin);
    admin_registry.admins.insert(addr);
}

/// Remove an admin (including, if desired, the caller themselves).
/// Refuses to remove the very last remaining admin — doing so would
/// recreate exactly the unrecoverable lockout this allow-list design
/// exists to avoid, just with an empty set instead of a lost object.
public entry fun admin_remove_admin(
    admin_registry: &mut AdminRegistry,
    addr: address,
    ctx: &TxContext,
) {
    assert!(admin_registry.admins.contains(&ctx.sender()), ENotAdmin);
    assert!(admin_registry.admins.contains(&addr), ENotCurrentAdmin);
    assert!(admin_registry.admins.length() > 1, ECannotRemoveLastAdmin);
    admin_registry.admins.remove(&addr);
}

// ===== Read-only accessors =====
// The frontend normally reads a Batch by fetching the object directly via
// `suiClient.getObject({ id, options: { showContent: true } })`, which is
// simpler than calling into Move for reads. These accessors exist so the
// same logic is also usable from Move (tests, other packages) and from
// `devInspectTransactionBlock` if you'd rather call into the chain than
// parse the raw object content on the frontend.

public fun batch_code(batch: &Batch): String { batch.batch_code }

public fun product_name(batch: &Batch): String { batch.product_name }

public fun manufacturer(batch: &Batch): address { batch.manufacturer }

public fun created_at_ms(batch: &Batch): u64 { batch.created_at_ms }

public fun expiry_ms(batch: &Batch): u64 { batch.expiry_ms }

/// Remaining staked collateral on this batch, in MIST — 0 once withdrawn
/// or slashed. See the `Batch.stake` doc comment.
public fun stake_amount(batch: &Batch): u64 { batch.stake.value() }

public fun checkpoint_count(batch: &Batch): u64 { batch.checkpoints.length() }

public fun checkpoints(batch: &Batch): &vector<Checkpoint> { &batch.checkpoints }

public fun checkpoint_actor(c: &Checkpoint): address { c.actor }

public fun checkpoint_role(c: &Checkpoint): String { c.role }

public fun checkpoint_location(c: &Checkpoint): String { c.location }

public fun checkpoint_timestamp_ms(c: &Checkpoint): u64 { c.timestamp_ms }

public fun checkpoint_note(c: &Checkpoint): String { c.note }

public fun checkpoint_has_temperature(c: &Checkpoint): bool { c.has_temperature }

public fun checkpoint_temperature_c_offset(c: &Checkpoint): u64 { c.temperature_c_offset }

/// Offset to subtract from `checkpoint_temperature_c_offset` to recover
/// the real Celsius value — exposed so callers don't have to hardcode
/// `TEMPERATURE_OFFSET_C`.
public fun temperature_offset_c(): u64 { TEMPERATURE_OFFSET_C }

public fun is_held(batch: &Batch): bool { batch.is_held }

public fun hold_reason(batch: &Batch): String { batch.hold_reason }

public fun hold_severity(batch: &Batch): u8 { batch.hold_severity }

public fun hold_category(batch: &Batch): u8 { batch.hold_category }

public fun hold_case_reference(batch: &Batch): String { batch.hold_case_reference }

public fun held_by(batch: &Batch): address { batch.held_by }

public fun held_at_ms(batch: &Batch): u64 { batch.held_at_ms }

public fun hold_history(batch: &Batch): &vector<HoldRecord> { &batch.hold_history }

public fun hold_escalated(batch: &Batch): bool { batch.hold_escalated }

public fun hold_record_held_by(r: &HoldRecord): address { r.held_by }

public fun hold_record_reason(r: &HoldRecord): String { r.reason }

public fun hold_record_severity(r: &HoldRecord): u8 { r.severity }

public fun hold_record_category(r: &HoldRecord): u8 { r.category }

public fun hold_record_case_reference(r: &HoldRecord): String { r.case_reference }

public fun hold_record_held_at_ms(r: &HoldRecord): u64 { r.held_at_ms }

public fun hold_record_is_released(r: &HoldRecord): bool { r.released_by.is_some() }

public fun hold_record_released_by(r: &HoldRecord): Option<address> { r.released_by }

public fun hold_record_released_at_ms(r: &HoldRecord): Option<u64> { r.released_at_ms }

public fun hold_record_release_note(r: &HoldRecord): Option<String> { r.release_note }

public fun hold_record_co_released_by(r: &HoldRecord): Option<address> { r.co_released_by }

public fun hold_record_escalated(r: &HoldRecord): bool { r.escalated }

/// Review-window thresholds (ms) used by `escalate_stale_hold`, exposed so
/// callers (tests, the frontend) don't have to hardcode them.
public fun critical_review_ms(): u64 { CRITICAL_REVIEW_MS }

public fun recall_review_ms(): u64 { RECALL_REVIEW_MS }

public fun advisory_review_ms(): u64 { ADVISORY_REVIEW_MS }

/// The address that proposed releasing the currently-active critical
/// hold, while `confirm_release` is still pending. `none` if there's no
/// hold, the hold isn't critical, or nobody has proposed a release yet.
public fun pending_release_by(batch: &Batch): Option<address> { batch.pending_release_by }

public fun pending_release_note(batch: &Batch): Option<String> { batch.pending_release_note }

/// The `severity` value meaning "advisory" — informational, no immediate
/// sale stoppage implied beyond the hold itself.
public fun severity_advisory(): u8 { SEVERITY_ADVISORY }

/// The `severity` value meaning "recall" — a defined batch-level recall.
public fun severity_recall(): u8 { SEVERITY_RECALL }

/// The `severity` value meaning "critical" — stop-sale, most urgent.
public fun severity_critical(): u8 { SEVERITY_CRITICAL }

public fun category_counterfeit(): u8 { CATEGORY_COUNTERFEIT }

public fun category_quality_defect(): u8 { CATEGORY_QUALITY_DEFECT }

public fun category_labeling_error(): u8 { CATEGORY_LABELING_ERROR }

public fun category_cold_chain_breach(): u8 { CATEGORY_COLD_CHAIN_BREACH }

public fun category_other(): u8 { CATEGORY_OTHER }

public fun is_admin(registry: &AdminRegistry, addr: address): bool {
    registry.admins.contains(&addr)
}

/// All currently-listed admin addresses — lets an admin UI show who has
/// access right now without needing to replay every add/remove event.
public fun admins(registry: &AdminRegistry): vector<address> {
    *registry.admins.keys()
}

public fun is_regulator(registry: &RegulatorRegistry, addr: address): bool {
    registry.regulators.contains(&addr)
}

/// All currently-listed regulator addresses — lets an admin UI show who
/// has access right now without needing to replay every add/revoke event.
public fun regulators(registry: &RegulatorRegistry): vector<address> {
    *registry.regulators.keys()
}

public fun is_manufacturer(registry: &ManufacturerRegistry, addr: address): bool {
    registry.manufacturers.contains(&addr)
}

public fun manufacturers(registry: &ManufacturerRegistry): vector<address> {
    *registry.manufacturers.keys()
}

public fun unit_batch_id(unit: &Unit): address { unit.batch_id }

public fun unit_price(unit: &Unit): u64 { unit.price }

public fun unit_manufacturer(unit: &Unit): address { unit.manufacturer }

public fun unit_minted_at_ms(unit: &Unit): u64 { unit.minted_at_ms }

/// How long (ms) a `Unit` stays redeemable after minting — exposed so
/// callers (tests, the frontend) don't have to hardcode `UNIT_EXPIRY_MS`.
public fun unit_expiry_ms(): u64 { UNIT_EXPIRY_MS }
