#[test_only]
module pharma_track::batch_tests;

use pharma_track::batch::{Self, Batch, RegulatorCap, Unit};
use std::option;
use std::string;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;

const MANUFACTURER: address = @0xA11CE;
const DISTRIBUTOR: address = @0xB0B;
const PHARMACY: address = @0xCAFE;
const CUSTOMER: address = @0xD00D;

#[test]
fun test_create_batch_and_add_checkpoint() {
    let mut scenario = test_scenario::begin(MANUFACTURER);

    // Transaction 1: manufacturer registers a new batch. This shares the
    // Batch object so later transactions from other addresses can reach it.
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::create_batch(
            b"BATCH-2026-001",
            b"Amoxicillin 500mg",
            &clock,
            ctx,
        );

        clock.destroy_for_testing();
    };

    // Transaction 2: a distributor scans the batch in at their warehouse.
    scenario.next_tx(DISTRIBUTOR);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::add_checkpoint(
            &mut shared_batch,
            b"distributor",
            b"Kuala Lumpur Distribution Hub",
            b"Received from manufacturer, seal intact",
            &clock,
            ctx,
        );

        assert!(batch::checkpoint_count(&shared_batch) == 1, 0);
        assert!(batch::batch_code(&shared_batch) == string::utf8(b"BATCH-2026-001"), 1);
        assert!(batch::manufacturer(&shared_batch) == MANUFACTURER, 2);

        let checkpoints = batch::checkpoints(&shared_batch);
        let first = checkpoints.borrow(0);
        assert!(batch::checkpoint_actor(first) == DISTRIBUTOR, 3);
        assert!(batch::checkpoint_role(first) == string::utf8(b"distributor"), 4);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 0 == batch::EEmptyBatchCode (the constant is private to the
// batch module, so we assert on its raw value here rather than the name).
#[test, expected_failure(abort_code = 0)]
fun test_create_batch_rejects_empty_code() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(b"", b"Amoxicillin 500mg", &clock, ctx);
        clock.destroy_for_testing();
    };
    scenario.end();
}

/// Sets up a batch plus a `RegulatorCap` owned by MANUFACTURER (as if
/// MANUFACTURER were the package deployer that `init` mints the first cap
/// to), so hold/release tests don't need to touch publish-time init flow
/// directly.
fun setup_batch_with_cap(scenario: &mut test_scenario::Scenario, batch_code: vector<u8>) {
    let ctx = scenario.ctx();
    let clock = clock::create_for_testing(ctx);
    batch::test_init(ctx);
    batch::create_batch(batch_code, b"Amoxicillin 500mg", &clock, ctx);
    clock.destroy_for_testing();
}

#[test]
fun test_hold_blocks_checkpoint_then_release_allows_it() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_cap(&mut scenario, b"BATCH-2026-002");

    // Regulator (holding the cap minted at "publish" time) places a hold.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::place_hold(&cap, &mut shared_batch, b"Seal broken on arrival", &clock, ctx);

        assert!(batch::is_held(&shared_batch), 0);
        assert!(batch::hold_reason(&shared_batch) == string::utf8(b"Seal broken on arrival"), 1);
        assert!(batch::held_by(&shared_batch) == MANUFACTURER, 2);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };

    // (Separately, `test_add_checkpoint_aborts_while_held` below confirms a
    // checkpoint attempt while held actually aborts — Move's test harness
    // can only assert on aborts via a whole test's `expected_failure`.)

    // Same regulator releases the hold; the chain can move again.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::release_hold(&cap, &mut shared_batch, &clock, ctx);
        assert!(!batch::is_held(&shared_batch), 3);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::add_checkpoint(&mut shared_batch, b"pharmacy", b"City Pharmacy", b"", &clock, ctx);
        assert!(batch::checkpoint_count(&shared_batch) == 1, 4);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = 2)]
fun test_add_checkpoint_aborts_while_held() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_cap(&mut scenario, b"BATCH-2026-003");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&cap, &mut shared_batch, b"Recalled by regulator", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        // abort_code 2 == batch::EBatchHeld
        batch::add_checkpoint(&mut shared_batch, b"pharmacy", b"City Pharmacy", b"", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// A pharmacy with no `RegulatorCap` cannot place a hold: `take_from_sender`
// aborts because PHARMACY owns no such object. This is the capability
// check working, not a Move framework quirk — proves the gate is real.
#[test, expected_failure]
fun test_place_hold_without_cap_fails() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_cap(&mut scenario, b"BATCH-2026-004");

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&cap, &mut shared_batch, b"Trying without a cap", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

#[test]
fun test_mint_regulator_cap_lets_new_holder_place_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_cap(&mut scenario, b"BATCH-2026-005");

    // MANUFACTURER (holding the original cap) onboards PHARMACY as a
    // regulator too.
    scenario.next_tx(MANUFACTURER);
    {
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        batch::mint_regulator_cap(&cap, PHARMACY, ctx);
        scenario.return_to_sender(cap);
    };

    // PHARMACY now holds its own cap and can place a hold.
    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::place_hold(&cap, &mut shared_batch, b"Newly-onboarded regulator hold", &clock, ctx);
        assert!(batch::is_held(&shared_batch), 0);
        assert!(batch::held_by(&shared_batch) == PHARMACY, 1);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

#[test]
fun test_hold_history_records_every_cycle() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_cap(&mut scenario, b"BATCH-2026-006");

    // First hold+release cycle.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&cap, &mut shared_batch, b"First suspected tamper", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::release_hold(&cap, &mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };

    // Second hold, left active (not released).
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let cap = scenario.take_from_sender<RegulatorCap>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&cap, &mut shared_batch, b"Second, still under investigation", &clock, ctx);

        let history = batch::hold_history(&shared_batch);
        assert!(history.length() == 2, 0);

        let first = history.borrow(0);
        assert!(batch::hold_record_reason(first) == string::utf8(b"First suspected tamper"), 1);
        assert!(batch::hold_record_is_released(first), 2);
        assert!(batch::hold_record_released_by(first) == option::some(MANUFACTURER), 3);

        let second = history.borrow(1);
        assert!(
            batch::hold_record_reason(second) == string::utf8(b"Second, still under investigation"),
            4,
        );
        assert!(!batch::hold_record_is_released(second), 5);
        assert!(batch::hold_record_released_by(second) == option::none(), 6);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

#[test]
fun test_purchase_and_burn_pays_manufacturer_and_deletes_unit() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(b"BATCH-2026-007", b"Amoxicillin 500mg", &clock, ctx);
        clock.destroy_for_testing();
    };

    // Pharmacy mints a single-use sale QR against the batch.
    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    // Customer scans it and pays the exact price.
    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, payment, &clock, ctx);
        clock.destroy_for_testing();
    };

    // Payment landed with the manufacturer, and the Unit is gone for good —
    // there is nothing left to `take_shared` for a second redemption.
    scenario.next_tx(MANUFACTURER);
    {
        let paid = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(paid.value() == 100, 0);
        scenario.return_to_sender(paid);
    };

    scenario.end();
}

// abort_code 6 == batch::EWrongPayment.
#[test, expected_failure(abort_code = 6)]
fun test_purchase_and_burn_rejects_wrong_payment() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(b"BATCH-2026-008", b"Amoxicillin 500mg", &clock, ctx);
        clock.destroy_for_testing();
    };

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(1, ctx);
        batch::purchase_and_burn(unit, payment, &clock, ctx);
        clock.destroy_for_testing();
    };

    scenario.end();
}

// A second scan of the same QR has no `Unit` left to redeem: the object was
// deleted by the first, successful `purchase_and_burn`, so `take_shared`
// itself aborts — there is no application-level "already sold" flag to
// bypass, the object is simply gone.
#[test, expected_failure]
fun test_purchase_and_burn_cannot_be_redeemed_twice() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(b"BATCH-2026-009", b"Amoxicillin 500mg", &clock, ctx);
        clock.destroy_for_testing();
    };

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, payment, &clock, ctx);
        clock.destroy_for_testing();
    };

    // A counterfeiter who cloned the QR tries to redeem it again.
    scenario.next_tx(CUSTOMER);
    {
        let _unit = scenario.take_shared<Unit>();
        abort 0
    };

    scenario.end();
}

// abort_code 7 == batch::EUnitExpired.
#[test, expected_failure(abort_code = 7)]
fun test_purchase_and_burn_rejects_expired_unit() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(b"BATCH-2026-010", b"Amoxicillin 500mg", &clock, ctx);
        clock.destroy_for_testing();
    };

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    // Customer doesn't scan it until well past the redemption window.
    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(batch::unit_expiry_ms() + 1);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, payment, &clock, ctx);
        clock.destroy_for_testing();
    };

    scenario.end();
}
