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
/// Placing/releasing a hold IS capability-gated (unlike `add_checkpoint`):
/// a hold is a much stronger action — it freezes the whole custody chain —
/// so it requires a `RegulatorCap` object rather than just an address. One
/// `RegulatorCap` is minted to the package deployer at publish time; that
/// holder (or anyone they choose to mint a cap for) can then place holds.
///
/// A hold carries a `severity` classification (`SEVERITY_*`), a mandatory
/// `case_reference` for cross-referencing off-chain paperwork, and — on
/// release — a mandatory `release_note`. All three are required inputs,
/// not optional metadata: a regulatory hold with no severity, no case to
/// point back to, or no stated reason for lifting it isn't a usable audit
/// record, just a flag that got flipped twice.
///
/// A hold also gates sales, not just custody: `mint_unit` and
/// `purchase_and_burn` both abort while `is_held` is true. Without this, a
/// batch could be placed under a "Critical — stop sale" hold and someone
/// could still mint and sell a `Unit` against it seconds later — the hold
/// would be evidence after the fact, not an actual stoppage.
///
/// `SEVERITY_CRITICAL` holds cannot be released by a single signer.
/// `release_hold` aborts for them; releasing one requires `propose_release`
/// from one `RegulatorCap` holder followed by `confirm_release` from a
/// *different* one. This mirrors how real recalls work: one person can
/// pull the emergency brake alone, but nobody unilaterally decides a
/// critical stop-sale is over.
module pharma_track::batch;

use std::option::{Self, Option};
use std::string::{Self, String};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;

/// A single custody event in a batch's lifecycle.
public struct Checkpoint has copy, drop, store {
    /// Address that submitted this checkpoint (the tx sender, not user input).
    actor: address,
    /// Free-form role label, e.g. b"manufacturer", b"distributor", b"pharmacy".
    role: String,
    location: String,
    timestamp_ms: u64,
    note: String,
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
}

/// On-chain record for one drug batch.
public struct Batch has key {
    id: UID,
    batch_code: String,
    product_name: String,
    manufacturer: address,
    created_at_ms: u64,
    checkpoints: vector<Checkpoint>,
    /// True while the batch is under hold (e.g. a suspected counterfeit or
    /// a recall). While held, `add_checkpoint` aborts — the custody chain
    /// is frozen until someone releases the hold.
    is_held: bool,
    hold_reason: String,
    hold_severity: u8,
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
}

/// Capability required to place or release a hold on a batch. Minted once
/// to the deployer at publish time; holders can mint further caps via
/// `mint_regulator_cap` to onboard other regulators/pharmacies.
public struct RegulatorCap has key, store {
    id: UID,
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
}

fun init(ctx: &mut TxContext) {
    transfer::transfer(RegulatorCap { id: object::new(ctx) }, ctx.sender());
}

#[test_only]
public fun test_init(ctx: &mut TxContext) {
    init(ctx);
}

// ===== Events =====
// The frontend listens to these instead of polling full objects, and the
// public lookup page can replay them to reconstruct history for an object
// even before it reads the object's current fields.

public struct BatchCreated has copy, drop {
    batch_id: address,
    batch_code: String,
    product_name: String,
    manufacturer: address,
    created_at_ms: u64,
}

public struct CheckpointAdded has copy, drop {
    batch_id: address,
    actor: address,
    role: String,
    location: String,
    timestamp_ms: u64,
    checkpoint_index: u64,
}

public struct BatchHeld has copy, drop {
    batch_id: address,
    held_by: address,
    reason: String,
    severity: u8,
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

/// Hold severity classifications, loosely modeled on how regulators
/// actually grade recalls (e.g. FDA Class I/II/III): the higher the
/// number, the more urgent. Plain `u8` constants rather than a Move enum
/// so `place_hold`'s `severity: u8` parameter stays simple to build from
/// the frontend and to validate with a single range check.
const SEVERITY_ADVISORY: u8 = 1;
const SEVERITY_RECALL: u8 = 2;
const SEVERITY_CRITICAL: u8 = 3;

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

// ===== Entry functions =====

/// Create a new batch and share it immediately so every later party in the
/// supply chain can attach a checkpoint to the same object.
public entry fun create_batch(
    batch_code: vector<u8>,
    product_name: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(batch_code.length() > 0, EEmptyBatchCode);
    assert!(product_name.length() > 0, EEmptyProductName);

    let sender = ctx.sender();
    let now = clock.timestamp_ms();

    let batch = Batch {
        id: object::new(ctx),
        batch_code: string::utf8(batch_code),
        product_name: string::utf8(product_name),
        manufacturer: sender,
        created_at_ms: now,
        checkpoints: vector::empty<Checkpoint>(),
        is_held: false,
        hold_reason: string::utf8(b""),
        hold_severity: 0,
        hold_case_reference: string::utf8(b""),
        held_by: @0x0,
        held_at_ms: 0,
        hold_history: vector::empty<HoldRecord>(),
        pending_release_by: option::none(),
        pending_release_note: option::none(),
    };

    event::emit(BatchCreated {
        batch_id: object::uid_to_address(&batch.id),
        batch_code: batch.batch_code,
        product_name: batch.product_name,
        manufacturer: sender,
        created_at_ms: now,
    });

    transfer::share_object(batch);
}

/// Record a custody handoff / scan against an existing shared batch.
/// Anyone can call this — the point of the MVP is that every call is
/// permanently and publicly attributed to `ctx.sender()`, which is what
/// the off-chain anomaly layer reasons over.
public entry fun add_checkpoint(
    batch: &mut Batch,
    role: vector<u8>,
    location: vector<u8>,
    note: vector<u8>,
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
    };

    batch.checkpoints.push_back(checkpoint);

    event::emit(CheckpointAdded {
        batch_id: object::uid_to_address(&batch.id),
        actor: sender,
        role: checkpoint.role,
        location: checkpoint.location,
        timestamp_ms: now,
        checkpoint_index: batch.checkpoints.length() - 1,
    });
}

/// Mint one sellable, single-use `Unit` against a batch. Called by
/// whoever is dispensing the physical package (typically the pharmacy) at
/// the price they're selling it for, in MIST. The returned QR should be
/// printed/shown on that one physical package only — anyone who redeems
/// it via `purchase_and_burn` gets the object deleted out from under any
/// later scan.
///
/// Aborts if the batch is on hold — a recalled or suspect batch shouldn't
/// be sellable in the first place, not just flagged after the fact.
public entry fun mint_unit(
    batch: &Batch,
    price: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!batch.is_held, EBatchHeld);
    assert!(price > 0, EZeroPrice);

    let now = clock.timestamp_ms();
    let unit = Unit {
        id: object::new(ctx),
        batch_id: object::uid_to_address(&batch.id),
        price,
        manufacturer: batch.manufacturer,
        minted_at_ms: now,
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
public entry fun purchase_and_burn(
    unit: Unit,
    batch: &Batch,
    payment: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(unit.batch_id == object::uid_to_address(&batch.id), EUnitBatchMismatch);
    assert!(!batch.is_held, EBatchHeld);

    let now = clock.timestamp_ms();
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

    let Unit { id, batch_id: _, price: _, manufacturer: _, minted_at_ms: _ } = unit;
    object::delete(id);
}

/// Place a hold on a batch — freezes the custody chain (no further
/// checkpoints can be added) until someone releases it. Requires a
/// `RegulatorCap`; the caller's address is also permanently attributed as
/// `held_by` on top of that capability check.
///
/// `severity` must be one of the `SEVERITY_*` constants, and both `reason`
/// and `case_reference` are mandatory — a hold with no classification or
/// no external case number to cross-reference isn't useful evidence later.
public entry fun place_hold(
    _cap: &RegulatorCap,
    batch: &mut Batch,
    reason: vector<u8>,
    severity: u8,
    case_reference: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!batch.is_held, EBatchHeld);
    assert!(reason.length() > 0, EEmptyHoldReason);
    assert!(
        severity == SEVERITY_ADVISORY || severity == SEVERITY_RECALL || severity == SEVERITY_CRITICAL,
        EInvalidSeverity,
    );
    assert!(case_reference.length() > 0, EEmptyCaseReference);

    let sender = ctx.sender();
    let now = clock.timestamp_ms();

    batch.is_held = true;
    batch.hold_reason = string::utf8(reason);
    batch.hold_severity = severity;
    batch.hold_case_reference = string::utf8(case_reference);
    batch.held_by = sender;
    batch.held_at_ms = now;

    batch.hold_history.push_back(HoldRecord {
        held_by: sender,
        reason: batch.hold_reason,
        severity,
        case_reference: batch.hold_case_reference,
        held_at_ms: now,
        released_by: option::none(),
        released_at_ms: option::none(),
        release_note: option::none(),
        co_released_by: option::none(),
    });

    event::emit(BatchHeld {
        batch_id: object::uid_to_address(&batch.id),
        held_by: sender,
        reason: batch.hold_reason,
        severity,
        case_reference: batch.hold_case_reference,
        held_at_ms: now,
    });
}

/// Release a previously placed hold, unfreezing the custody chain.
/// Requires a `RegulatorCap` — not necessarily the same one that placed
/// the hold, since caps are fungible proof of role, not per-hold tickets.
/// `release_note` is mandatory: "who released it and when" without "why
/// it was safe to" is an audit gap, not a complete record.
///
/// Aborts for `SEVERITY_CRITICAL` holds — those require two different
/// signers via `propose_release` + `confirm_release` instead. See the
/// module doc comment for why.
public entry fun release_hold(
    _cap: &RegulatorCap,
    batch: &mut Batch,
    release_note: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(batch.is_held, EBatchNotHeld);
    assert!(batch.hold_severity != SEVERITY_CRITICAL, ECriticalRequiresMultisig);
    assert!(release_note.length() > 0, EEmptyReleaseNote);

    let sender = ctx.sender();
    let now = clock.timestamp_ms();
    let note = string::utf8(release_note);

    finish_release(batch, sender, note, option::none(), now);
}

/// First signature of a critical hold's release: records who's proposing
/// it and why, but does NOT unfreeze anything yet — `confirm_release`
/// still has to happen, from a different `RegulatorCap` holder.
public entry fun propose_release(
    _cap: &RegulatorCap,
    batch: &mut Batch,
    note: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(batch.is_held, EBatchNotHeld);
    assert!(batch.hold_severity == SEVERITY_CRITICAL, ECriticalRequiresMultisig);
    assert!(batch.pending_release_by.is_none(), EReleaseAlreadyProposed);
    assert!(note.length() > 0, EEmptyReleaseNote);

    let sender = ctx.sender();
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

/// Second signature of a critical hold's release: must come from a
/// `RegulatorCap` holder other than whoever called `propose_release`.
/// Actually unfreezes the batch, using the note captured at proposal time
/// — the confirming signer is vouching for that stated reason, not
/// writing a new one, since the whole point is two people agreeing on the
/// same justification.
public entry fun confirm_release(
    _cap: &RegulatorCap,
    batch: &mut Batch,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(batch.pending_release_by.is_some(), ENoReleaseProposed);

    let sender = ctx.sender();
    let proposer = *batch.pending_release_by.borrow();
    assert!(sender != proposer, ESameRegulatorCannotConfirm);

    let note = batch.pending_release_note.extract();
    batch.pending_release_by = option::none();

    let now = clock.timestamp_ms();
    finish_release(batch, sender, note, option::some(proposer), now);
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
    batch.hold_case_reference = string::utf8(b"");
    batch.held_by = @0x0;
    batch.held_at_ms = 0;

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

/// Onboard another regulator/pharmacy by minting them a `RegulatorCap`.
/// Only an existing cap holder can do this, so trust chains back to the
/// original deployer — there is no way to self-mint a cap out of thin air.
public entry fun mint_regulator_cap(_cap: &RegulatorCap, recipient: address, ctx: &mut TxContext) {
    transfer::transfer(RegulatorCap { id: object::new(ctx) }, recipient);
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

public fun checkpoint_count(batch: &Batch): u64 { batch.checkpoints.length() }

public fun checkpoints(batch: &Batch): &vector<Checkpoint> { &batch.checkpoints }

public fun checkpoint_actor(c: &Checkpoint): address { c.actor }

public fun checkpoint_role(c: &Checkpoint): String { c.role }

public fun checkpoint_location(c: &Checkpoint): String { c.location }

public fun checkpoint_timestamp_ms(c: &Checkpoint): u64 { c.timestamp_ms }

public fun checkpoint_note(c: &Checkpoint): String { c.note }

public fun is_held(batch: &Batch): bool { batch.is_held }

public fun hold_reason(batch: &Batch): String { batch.hold_reason }

public fun hold_severity(batch: &Batch): u8 { batch.hold_severity }

public fun hold_case_reference(batch: &Batch): String { batch.hold_case_reference }

public fun held_by(batch: &Batch): address { batch.held_by }

public fun held_at_ms(batch: &Batch): u64 { batch.held_at_ms }

public fun hold_history(batch: &Batch): &vector<HoldRecord> { &batch.hold_history }

public fun hold_record_held_by(r: &HoldRecord): address { r.held_by }

public fun hold_record_reason(r: &HoldRecord): String { r.reason }

public fun hold_record_severity(r: &HoldRecord): u8 { r.severity }

public fun hold_record_case_reference(r: &HoldRecord): String { r.case_reference }

public fun hold_record_held_at_ms(r: &HoldRecord): u64 { r.held_at_ms }

public fun hold_record_is_released(r: &HoldRecord): bool { r.released_by.is_some() }

public fun hold_record_released_by(r: &HoldRecord): Option<address> { r.released_by }

public fun hold_record_released_at_ms(r: &HoldRecord): Option<u64> { r.released_at_ms }

public fun hold_record_release_note(r: &HoldRecord): Option<String> { r.release_note }

public fun hold_record_co_released_by(r: &HoldRecord): Option<address> { r.co_released_by }

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

public fun unit_batch_id(unit: &Unit): address { unit.batch_id }

public fun unit_price(unit: &Unit): u64 { unit.price }

public fun unit_manufacturer(unit: &Unit): address { unit.manufacturer }

public fun unit_minted_at_ms(unit: &Unit): u64 { unit.minted_at_ms }

/// How long (ms) a `Unit` stays redeemable after minting — exposed so
/// callers (tests, the frontend) don't have to hardcode `UNIT_EXPIRY_MS`.
public fun unit_expiry_ms(): u64 { UNIT_EXPIRY_MS }
