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

/// One full hold+release cycle. `released_by`/`released_at_ms` are `none`
/// while the hold is still active — this is what makes the record durable:
/// unlike the `is_held`/`hold_reason`/... fields on `Batch` (which only
/// describe the *current* hold and get reset on release), every entry here
/// stays in `hold_history` forever, so a batch that was held and released
/// three times still shows all three as evidence.
public struct HoldRecord has copy, drop, store {
    held_by: address,
    reason: String,
    held_at_ms: u64,
    released_by: Option<address>,
    released_at_ms: Option<u64>,
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
    held_by: address,
    held_at_ms: u64,
    /// Every hold+release cycle this batch has ever been through, oldest
    /// first. The currently-active hold (if any) is always the last entry,
    /// with `released_by`/`released_at_ms` still `none`.
    hold_history: vector<HoldRecord>,
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
    held_at_ms: u64,
}

public struct BatchReleased has copy, drop {
    batch_id: address,
    released_by: address,
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
        held_by: @0x0,
        held_at_ms: 0,
        hold_history: vector::empty<HoldRecord>(),
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
public entry fun mint_unit(
    batch: &Batch,
    price: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
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
public entry fun purchase_and_burn(
    unit: Unit,
    payment: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
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
public entry fun place_hold(
    _cap: &RegulatorCap,
    batch: &mut Batch,
    reason: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!batch.is_held, EBatchHeld);
    assert!(reason.length() > 0, EEmptyHoldReason);

    let sender = ctx.sender();
    let now = clock.timestamp_ms();

    batch.is_held = true;
    batch.hold_reason = string::utf8(reason);
    batch.held_by = sender;
    batch.held_at_ms = now;

    batch.hold_history.push_back(HoldRecord {
        held_by: sender,
        reason: batch.hold_reason,
        held_at_ms: now,
        released_by: option::none(),
        released_at_ms: option::none(),
    });

    event::emit(BatchHeld {
        batch_id: object::uid_to_address(&batch.id),
        held_by: sender,
        reason: batch.hold_reason,
        held_at_ms: now,
    });
}

/// Release a previously placed hold, unfreezing the custody chain.
/// Requires a `RegulatorCap` — not necessarily the same one that placed
/// the hold, since caps are fungible proof of role, not per-hold tickets.
public entry fun release_hold(
    _cap: &RegulatorCap,
    batch: &mut Batch,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(batch.is_held, EBatchNotHeld);

    let sender = ctx.sender();
    let now = clock.timestamp_ms();

    batch.is_held = false;
    batch.hold_reason = string::utf8(b"");
    batch.held_by = @0x0;
    batch.held_at_ms = 0;

    let last_index = batch.hold_history.length() - 1;
    let last_record = batch.hold_history.borrow_mut(last_index);
    last_record.released_by = option::some(sender);
    last_record.released_at_ms = option::some(now);

    event::emit(BatchReleased {
        batch_id: object::uid_to_address(&batch.id),
        released_by: sender,
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

public fun held_by(batch: &Batch): address { batch.held_by }

public fun held_at_ms(batch: &Batch): u64 { batch.held_at_ms }

public fun hold_history(batch: &Batch): &vector<HoldRecord> { &batch.hold_history }

public fun hold_record_held_by(r: &HoldRecord): address { r.held_by }

public fun hold_record_reason(r: &HoldRecord): String { r.reason }

public fun hold_record_held_at_ms(r: &HoldRecord): u64 { r.held_at_ms }

public fun hold_record_is_released(r: &HoldRecord): bool { r.released_by.is_some() }

public fun hold_record_released_by(r: &HoldRecord): Option<address> { r.released_by }

public fun hold_record_released_at_ms(r: &HoldRecord): Option<u64> { r.released_at_ms }

public fun unit_batch_id(unit: &Unit): address { unit.batch_id }

public fun unit_price(unit: &Unit): u64 { unit.price }

public fun unit_manufacturer(unit: &Unit): address { unit.manufacturer }

public fun unit_minted_at_ms(unit: &Unit): u64 { unit.minted_at_ms }

/// How long (ms) a `Unit` stays redeemable after minting — exposed so
/// callers (tests, the frontend) don't have to hardcode `UNIT_EXPIRY_MS`.
public fun unit_expiry_ms(): u64 { UNIT_EXPIRY_MS }
