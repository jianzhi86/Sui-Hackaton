#[test_only]
module pharma_track::batch_tests;

use pharma_track::batch::{
    Self,
    AdminRegistry,
    Batch,
    ManufacturerRegistry,
    PharmacyRegistry,
    RegulatorRegistry,
    SuspicionReport,
    Unit,
};
use std::hash;
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

/// Far enough out that no test's clock manipulation will accidentally
/// cross it — used everywhere a test doesn't care about expiry itself.
const FAR_FUTURE_MS: u64 = 4_102_444_800_000; // year 2100

/// A stand-in one-time scratch-off code, used everywhere a test needs
/// `mint_unit`/`purchase_and_burn`'s secret but isn't specifically testing
/// the secret-mismatch behavior.
const TEST_SECRET: vector<u8> = b"scratch-code-1234";

/// Runs `init` (creating + sharing both registries plus `AdminRegistry`,
/// seeding MANUFACTURER as its sole admin, as if MANUFACTURER were the
/// package deployer), then registers one batch via the just-shared
/// `ManufacturerRegistry`. Split across two transactions because a shared
/// object created by `init` isn't visible to `take_shared` until the
/// transaction that shared it has committed via `next_tx`.
fun setup_batch(scenario: &mut test_scenario::Scenario, batch_code: vector<u8>, expiry_ms: u64) {
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };
    scenario.next_tx(MANUFACTURER);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(&registry, batch_code, b"Amoxicillin 500mg", expiry_ms, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };
    // Onboard PHARMACY as a listed pharmacy — most tests act as PHARMACY
    // when minting a Unit, and mint_unit now requires registry membership.
    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_pharmacy(&admin_registry, &mut pharmacy_registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(pharmacy_registry);
    };
}

/// `setup_batch` with a far-future expiry, for tests that aren't about
/// expiry at all (most of the hold/sale tests).
fun setup_batch_with_registry(scenario: &mut test_scenario::Scenario, batch_code: vector<u8>) {
    setup_batch(scenario, batch_code, FAR_FUTURE_MS);
}

#[test]
fun test_create_batch_and_add_checkpoint() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-001", FAR_FUTURE_MS);

    // A distributor scans the batch in at their warehouse.
    scenario.next_tx(DISTRIBUTOR);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        // Reports a real temperature reading: 5°C, encoded as
        // 5 + TEMPERATURE_OFFSET_C.
        batch::add_checkpoint(
            &mut shared_batch,
            b"distributor",
            b"Kuala Lumpur Distribution Hub",
            b"Received from manufacturer, seal intact",
            true,
            batch::temperature_offset_c() + 5,
            &clock,
            ctx,
        );

        assert!(batch::checkpoint_count(&shared_batch) == 1, 0);
        assert!(batch::batch_code(&shared_batch) == string::utf8(b"BATCH-2026-001"), 1);
        assert!(batch::manufacturer(&shared_batch) == MANUFACTURER, 2);
        assert!(batch::expiry_ms(&shared_batch) == FAR_FUTURE_MS, 3);

        let checkpoints = batch::checkpoints(&shared_batch);
        let first = checkpoints.borrow(0);
        assert!(batch::checkpoint_actor(first) == DISTRIBUTOR, 4);
        assert!(batch::checkpoint_role(first) == string::utf8(b"distributor"), 5);
        assert!(batch::checkpoint_has_temperature(first), 6);
        assert!(batch::checkpoint_temperature_c_offset(first) == batch::temperature_offset_c() + 5, 7);

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
        batch::test_init(ctx);
    };
    scenario.next_tx(MANUFACTURER);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(&registry, b"", b"Amoxicillin 500mg", FAR_FUTURE_MS, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };
    scenario.end();
}

// abort_code 20 == batch::ENotManufacturer. PHARMACY was never added to
// the ManufacturerRegistry, so it can't register a batch even though the
// registry object itself is shared and passable by anyone.
#[test, expected_failure(abort_code = 20)]
fun test_create_batch_rejects_non_manufacturer() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };
    scenario.next_tx(PHARMACY);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(&registry, b"BATCH-2026-023", b"Amoxicillin 500mg", FAR_FUTURE_MS, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };
    scenario.end();
}

// abort_code 23 == batch::EInvalidExpiry. A batch can't be born already expired.
#[test, expected_failure(abort_code = 23)]
fun test_create_batch_rejects_expiry_in_the_past() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };
    scenario.next_tx(MANUFACTURER);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        // clock starts at 0 in tests; expiry 0 is not > now (0).
        batch::create_batch(&registry, b"BATCH-2026-024", b"Amoxicillin 500mg", 0, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };
    scenario.end();
}

#[test]
fun test_admin_add_manufacturer_lets_new_holder_create_batch() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_manufacturer(&admin_registry, &mut registry, PHARMACY, ctx);
        assert!(batch::is_manufacturer(&registry, PHARMACY), 0);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(PHARMACY);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(&registry, b"BATCH-2026-025", b"Paracetamol 500mg", FAR_FUTURE_MS, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        assert!(batch::manufacturer(&shared_batch) == PHARMACY, 1);
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_admin_revoke_manufacturer_blocks_further_batches() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_manufacturer(&admin_registry, &mut registry, PHARMACY, ctx);
        batch::admin_revoke_manufacturer(&admin_registry, &mut registry, PHARMACY, ctx);
        assert!(!batch::is_manufacturer(&registry, PHARMACY), 0);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_hold_blocks_checkpoint_then_release_allows_it() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-002");

    // Regulator (MANUFACTURER, seeded into the registry at init) places a hold.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Seal broken on arrival",
            batch::severity_recall(),
            batch::category_quality_defect(),
            b"CASE-2026-001",
            &clock,
            ctx,
        );

        assert!(batch::is_held(&shared_batch), 0);
        assert!(batch::hold_reason(&shared_batch) == string::utf8(b"Seal broken on arrival"), 1);
        assert!(batch::held_by(&shared_batch) == MANUFACTURER, 2);
        assert!(batch::hold_severity(&shared_batch) == batch::severity_recall(), 6);
        assert!(batch::hold_category(&shared_batch) == batch::category_quality_defect(), 7);
        assert!(batch::hold_case_reference(&shared_batch) == string::utf8(b"CASE-2026-001"), 8);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    // (Separately, `test_add_checkpoint_aborts_while_held` below confirms a
    // checkpoint attempt while held actually aborts — Move's test harness
    // can only assert on aborts via a whole test's `expected_failure`.)

    // Same regulator releases the hold; the chain can move again.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::release_hold(&registry, &mut shared_batch, b"Reseal verified against manifest", &clock, ctx);
        assert!(!batch::is_held(&shared_batch), 3);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::add_checkpoint(&mut shared_batch, b"pharmacy", b"City Pharmacy", b"", false, 0, &clock, ctx);
        assert!(batch::checkpoint_count(&shared_batch) == 1, 4);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = 2)]
fun test_add_checkpoint_aborts_while_held() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-003");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Recalled by regulator",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-002",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        // abort_code 2 == batch::EBatchHeld
        batch::add_checkpoint(&mut shared_batch, b"pharmacy", b"City Pharmacy", b"", false, 0, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 16 == batch::ENotRegulator. PHARMACY was never added to the
// registry, so it can't place a hold even though the registry itself is a
// shared object anyone can pass into the call — the actual gate is the
// address membership check inside `place_hold`, not object possession.
#[test, expected_failure(abort_code = 16)]
fun test_place_hold_rejects_non_regulator() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-004");

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Trying without being a regulator",
            batch::severity_advisory(),
            batch::category_other(),
            b"CASE-2026-003",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_admin_add_regulator_lets_new_holder_place_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-005");

    // MANUFACTURER (a listed admin) onboards PHARMACY as a regulator.
    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_regulator(&admin_registry, &mut registry, PHARMACY, ctx);
        assert!(batch::is_regulator(&registry, PHARMACY), 0);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };

    // PHARMACY is now listed and can place a hold.
    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Newly-onboarded regulator hold",
            batch::severity_advisory(),
            batch::category_labeling_error(),
            b"CASE-2026-004",
            &clock,
            ctx,
        );
        assert!(batch::is_held(&shared_batch), 1);
        assert!(batch::held_by(&shared_batch) == PHARMACY, 2);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_admin_revoke_regulator_blocks_further_holds() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-005B");

    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_regulator(&admin_registry, &mut registry, PHARMACY, ctx);
        batch::admin_revoke_regulator(&admin_registry, &mut registry, PHARMACY, ctx);
        assert!(!batch::is_regulator(&registry, PHARMACY), 0);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 17 == batch::EAlreadyRegulator.
#[test, expected_failure(abort_code = 17)]
fun test_admin_add_regulator_rejects_duplicate() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-005C");

    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        // MANUFACTURER is already a regulator (seeded at init).
        batch::admin_add_regulator(&admin_registry, &mut registry, MANUFACTURER, ctx);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 18 == batch::ENotCurrentRegulator.
#[test, expected_failure(abort_code = 18)]
fun test_admin_revoke_regulator_rejects_non_member() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-005D");

    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        batch::admin_revoke_regulator(&admin_registry, &mut registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_hold_history_records_every_cycle() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-006");

    // First hold+release cycle.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"First suspected tamper",
            batch::severity_advisory(),
            batch::category_counterfeit(),
            b"CASE-2026-005",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::release_hold(&registry, &mut shared_batch, b"False alarm, seal intact on inspection", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    // Second hold, left active (not released).
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Second, still under investigation",
            batch::severity_critical(),
            batch::category_cold_chain_breach(),
            b"CASE-2026-006",
            &clock,
            ctx,
        );

        let history = batch::hold_history(&shared_batch);
        assert!(history.length() == 2, 0);

        let first = history.borrow(0);
        assert!(batch::hold_record_reason(first) == string::utf8(b"First suspected tamper"), 1);
        assert!(batch::hold_record_is_released(first), 2);
        assert!(batch::hold_record_released_by(first) == option::some(MANUFACTURER), 3);
        assert!(batch::hold_record_severity(first) == batch::severity_advisory(), 7);
        assert!(batch::hold_record_category(first) == batch::category_counterfeit(), 8);
        assert!(batch::hold_record_case_reference(first) == string::utf8(b"CASE-2026-005"), 9);
        assert!(
            batch::hold_record_release_note(first)
                == option::some(string::utf8(b"False alarm, seal intact on inspection")),
            10,
        );

        let second = history.borrow(1);
        assert!(
            batch::hold_record_reason(second) == string::utf8(b"Second, still under investigation"),
            4,
        );
        assert!(!batch::hold_record_is_released(second), 5);
        assert!(batch::hold_record_released_by(second) == option::none(), 6);
        assert!(batch::hold_record_severity(second) == batch::severity_critical(), 11);
        assert!(batch::hold_record_category(second) == batch::category_cold_chain_breach(), 12);
        assert!(batch::hold_record_release_note(second) == option::none(), 13);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 8 == batch::EInvalidSeverity.
#[test, expected_failure(abort_code = 8)]
fun test_place_hold_rejects_invalid_severity() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-011");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        // 99 isn't one of SEVERITY_ADVISORY/RECALL/CRITICAL.
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Bad severity",
            99,
            batch::category_other(),
            b"CASE-2026-007",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 19 == batch::EInvalidCategory.
#[test, expected_failure(abort_code = 19)]
fun test_place_hold_rejects_invalid_category() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-011B");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        // 99 isn't one of the CATEGORY_* constants.
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Bad category",
            batch::severity_advisory(),
            99,
            b"CASE-2026-007B",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 9 == batch::EEmptyCaseReference.
#[test, expected_failure(abort_code = 9)]
fun test_place_hold_rejects_empty_case_reference() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-012");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Missing case reference",
            batch::severity_advisory(),
            batch::category_other(),
            b"",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 10 == batch::EEmptyReleaseNote.
#[test, expected_failure(abort_code = 10)]
fun test_release_hold_rejects_empty_note() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-013");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Needs a release note test",
            batch::severity_advisory(),
            batch::category_other(),
            b"CASE-2026-008",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::release_hold(&registry, &mut shared_batch, b"", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_purchase_and_burn_pays_manufacturer_and_deletes_unit() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-007", FAR_FUTURE_MS);

    // Pharmacy mints a single-use sale QR against the batch.
    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    // Customer scans it and pays the exact price.
    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
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
    setup_batch(&mut scenario, b"BATCH-2026-008", FAR_FUTURE_MS);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(1, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
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
    setup_batch(&mut scenario, b"BATCH-2026-009", FAR_FUTURE_MS);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
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
    setup_batch(&mut scenario, b"BATCH-2026-010", FAR_FUTURE_MS);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    // Customer doesn't scan it until well past the redemption window.
    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(batch::unit_expiry_ms() + 1);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 2 == batch::EBatchHeld. A held batch cannot have new sale QRs
// minted against it — the hold is a stoppage, not just a warning label.
#[test, expected_failure(abort_code = 2)]
fun test_mint_unit_rejects_held_batch() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-014");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Suspected counterfeit",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-009",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

// abort_code 2 == batch::EBatchHeld. A `Unit` minted *before* a hold went
// active still can't be redeemed once the batch is held — the check at
// purchase time matters just as much as the one at mint time.
#[test, expected_failure(abort_code = 2)]
fun test_purchase_and_burn_rejects_batch_held_after_mint() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-015");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    // A hold lands in the window between minting and payment.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Recalled after sale QR was already minted",
            batch::severity_critical(),
            batch::category_quality_defect(),
            b"CASE-2026-010",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 24 == batch::EBatchExpired. A batch past its expiry can't
// have a new sale QR minted against it.
#[test, expected_failure(abort_code = 24)]
fun test_mint_unit_rejects_expired_batch() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-026", 1_000);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(1_001); // past the batch's expiry_ms of 1_000
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

// abort_code 24 == batch::EBatchExpired. A `Unit` minted *before* the
// batch expired still can't be redeemed once expiry has passed — the
// check at purchase time matters just as much as the one at mint time,
// mirroring how the hold checks work.
#[test, expected_failure(abort_code = 24)]
fun test_purchase_and_burn_rejects_batch_expired_after_mint() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-027", 10_000);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx); // clock at 0, well before expiry
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(10_001); // past expiry, still within the Unit's own 10-min window
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 11 == batch::EUnitBatchMismatch.
//
// Creates batch A, mints a Unit against it (which touches/returns A,
// making it the "most recently shared" Batch), THEN creates batch B in a
// later transaction (making B the new "most recent" one) — so `take_shared`
// unambiguously resolves to each batch when we need it, without relying on
// `take_shared_by_id` or reading IDs out of same-transaction state that
// `test_scenario` hasn't committed yet.
#[test, expected_failure(abort_code = 11)]
fun test_purchase_and_burn_rejects_wrong_batch() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(&registry, b"BATCH-2026-016A", b"Amoxicillin 500mg", FAR_FUTURE_MS, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_pharmacy(&admin_registry, &mut pharmacy_registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.next_tx(PHARMACY);
    {
        let batch_a = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &batch_a, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(batch_a);
        test_scenario::return_shared(pharmacy_registry);
    };

    // Batch B is created — and therefore shared — after A was last
    // touched, so it's now unambiguously the "most recent" Batch.
    scenario.next_tx(MANUFACTURER);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(&registry, b"BATCH-2026-016B", b"Paracetamol 500mg", FAR_FUTURE_MS, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };

    // Try to redeem the Unit (minted against A) against B instead.
    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let batch_b = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &batch_b, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(batch_b);
    };

    scenario.end();
}

// abort_code 12 == batch::ECriticalRequiresMultisig. A single signer can't
// release a critical hold via the plain `release_hold` entry point.
#[test, expected_failure(abort_code = 12)]
fun test_release_hold_rejects_single_signer_for_critical() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-017");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Confirmed counterfeit",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-011",
            &clock,
            ctx,
        );
        batch::release_hold(&registry, &mut shared_batch, b"Trying to release alone", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_propose_then_confirm_release_by_different_regulators_succeeds() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-018");

    // Onboard PHARMACY as a second regulator.
    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_regulator(&admin_registry, &mut registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };

    // MANUFACTURER places a critical hold.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Confirmed counterfeit",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-012",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    // MANUFACTURER proposes releasing it.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::propose_release(&registry, &mut shared_batch, b"Independent lab confirmed genuine", &clock, ctx);

        assert!(batch::pending_release_by(&shared_batch) == option::some(MANUFACTURER), 0);
        assert!(batch::is_held(&shared_batch), 1); // still held — one signature isn't enough

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    // PHARMACY — a different regulator — confirms it.
    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_release(&registry, &mut shared_batch, &clock, ctx);

        assert!(!batch::is_held(&shared_batch), 2);
        assert!(batch::pending_release_by(&shared_batch) == option::none(), 3);

        let history = batch::hold_history(&shared_batch);
        let record = history.borrow(0);
        assert!(batch::hold_record_released_by(record) == option::some(PHARMACY), 4);
        assert!(batch::hold_record_co_released_by(record) == option::some(MANUFACTURER), 5);
        assert!(
            batch::hold_record_release_note(record)
                == option::some(string::utf8(b"Independent lab confirmed genuine")),
            6,
        );

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 15 == batch::ESameRegulatorCannotConfirm.
#[test, expected_failure(abort_code = 15)]
fun test_confirm_release_rejects_same_regulator() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-019");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Confirmed counterfeit",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-013",
            &clock,
            ctx,
        );
        batch::propose_release(&registry, &mut shared_batch, b"Trying to self-confirm", &clock, ctx);
        batch::confirm_release(&registry, &mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 14 == batch::ENoReleaseProposed.
#[test, expected_failure(abort_code = 14)]
fun test_confirm_release_rejects_without_proposal() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-020");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Confirmed counterfeit",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-014",
            &clock,
            ctx,
        );
        batch::confirm_release(&registry, &mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 12 == batch::ECriticalRequiresMultisig. Non-critical holds
// don't use the propose/confirm flow at all — release_hold handles them.
#[test, expected_failure(abort_code = 12)]
fun test_propose_release_rejects_non_critical_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-021");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Just a recall, not critical",
            batch::severity_recall(),
            batch::category_other(),
            b"CASE-2026-015",
            &clock,
            ctx,
        );
        batch::propose_release(&registry, &mut shared_batch, b"Trying multisig on a non-critical hold", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 13 == batch::EReleaseAlreadyProposed.
#[test, expected_failure(abort_code = 13)]
fun test_propose_release_rejects_duplicate_proposal() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-022");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Confirmed counterfeit",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-016",
            &clock,
            ctx,
        );
        batch::propose_release(&registry, &mut shared_batch, b"First proposal", &clock, ctx);
        batch::propose_release(&registry, &mut shared_batch, b"Second proposal", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

// abort_code 25 == batch::EInvalidSecretHash. A SHA-256 digest is always
// 32 bytes; anything else is rejected outright rather than silently
// accepted as an unreachable secret.
#[test, expected_failure(abort_code = 25)]
fun test_mint_unit_rejects_invalid_secret_hash_length() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-028", FAR_FUTURE_MS);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        // Not a 32-byte hash — just a short string.
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, b"too-short", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

// abort_code 26 == batch::ESecretMismatch. Knowing the Unit exists (and
// even its price) isn't enough to redeem it — the buyer needs the actual
// one-time code that was supposed to travel outside the visible QR.
#[test, expected_failure(abort_code = 26)]
fun test_purchase_and_burn_rejects_wrong_secret() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-029", FAR_FUTURE_MS);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    // A counterfeiter who only has the visible QR (and so only knows the
    // Unit's object ID, not the out-of-band secret) tries a guess.
    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, b"wrong-guess", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_admin_add_admin_lets_new_admin_manage_registries() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-030");

    // MANUFACTURER (seeded as the sole admin at init) adds PHARMACY as a
    // second, backup admin.
    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_admin(&mut admin_registry, PHARMACY, ctx);
        assert!(batch::is_admin(&admin_registry, PHARMACY), 0);
        test_scenario::return_shared(admin_registry);
    };

    // Now that a second admin exists, onboarding a regulator requires
    // propose + confirm from two *different* admins, not a direct call.
    scenario.next_tx(PHARMACY);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::propose_admin_action(
            &mut admin_registry,
            batch::admin_action_add_regulator(),
            DISTRIBUTOR,
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(admin_registry);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let mut regulator_registry = scenario.take_shared<RegulatorRegistry>();
        let mut manufacturer_registry = scenario.take_shared<ManufacturerRegistry>();
        let mut pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_admin_action(
            &mut admin_registry,
            &mut regulator_registry,
            &mut manufacturer_registry,
            &mut pharmacy_registry,
            &clock,
            ctx,
        );
        assert!(batch::is_regulator(&regulator_registry, DISTRIBUTOR), 1);
        clock.destroy_for_testing();
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(regulator_registry);
        test_scenario::return_shared(manufacturer_registry);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

// abort_code 30 == batch::ECannotRemoveLastAdmin.
#[test, expected_failure(abort_code = 30)]
fun test_admin_remove_admin_rejects_removing_last_admin() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let ctx = scenario.ctx();
        // MANUFACTURER is the only admin — this must abort rather than
        // leave the registry with no admin able to ever change it again.
        batch::admin_remove_admin(&mut admin_registry, MANUFACTURER, ctx);
        test_scenario::return_shared(admin_registry);
    };

    scenario.end();
}

#[test]
fun test_confirm_admin_action_removes_a_backup_admin() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };

    // Single admin — adding a backup is direct, single-signer.
    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_admin(&mut admin_registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
    };

    // Two admins now — removing one requires propose + confirm from a
    // *different* admin, not a direct single-signer call.
    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::propose_admin_action(&mut admin_registry, batch::admin_action_remove_admin(), PHARMACY, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(admin_registry);
    };

    scenario.next_tx(PHARMACY);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let mut regulator_registry = scenario.take_shared<RegulatorRegistry>();
        let mut manufacturer_registry = scenario.take_shared<ManufacturerRegistry>();
        let mut pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_admin_action(
            &mut admin_registry,
            &mut regulator_registry,
            &mut manufacturer_registry,
            &mut pharmacy_registry,
            &clock,
            ctx,
        );
        assert!(!batch::is_admin(&admin_registry, PHARMACY), 0);
        assert!(batch::is_admin(&admin_registry, MANUFACTURER), 1);
        clock.destroy_for_testing();
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(regulator_registry);
        test_scenario::return_shared(manufacturer_registry);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

// abort_code 41 == batch::EAdminActionRequiresProposal.
#[test, expected_failure(abort_code = 41)]
fun test_admin_remove_admin_rejects_direct_call_once_two_admins_exist() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_admin(&mut admin_registry, PHARMACY, ctx);
        // Two admins now — this direct call must abort, not silently
        // bypass the propose/confirm requirement.
        batch::admin_remove_admin(&mut admin_registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
    };

    scenario.end();
}

// abort_code 44 == batch::ESameAdminCannotConfirmAction.
#[test, expected_failure(abort_code = 44)]
fun test_confirm_admin_action_rejects_same_admin() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_admin(&mut admin_registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let mut admin_registry = scenario.take_shared<AdminRegistry>();
        let mut regulator_registry = scenario.take_shared<RegulatorRegistry>();
        let mut manufacturer_registry = scenario.take_shared<ManufacturerRegistry>();
        let mut pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::propose_admin_action(
            &mut admin_registry,
            batch::admin_action_add_regulator(),
            DISTRIBUTOR,
            &clock,
            ctx,
        );
        // Same admin (MANUFACTURER) tries to confirm their own proposal.
        batch::confirm_admin_action(
            &mut admin_registry,
            &mut regulator_registry,
            &mut manufacturer_registry,
            &mut pharmacy_registry,
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(regulator_registry);
        test_scenario::return_shared(manufacturer_registry);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

// abort_code 32 == batch::EHoldNotYetOverdue.
#[test, expected_failure(abort_code = 32)]
fun test_escalate_stale_hold_rejects_before_threshold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-031");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Just placed",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-031",
            &clock,
            ctx,
        );
        // Still well within the critical review window (1 day).
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_escalate_stale_hold_flags_overdue_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-032");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Critical stop-sale",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-032",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    // A day later, nobody has released it yet — anyone can flag it.
    scenario.next_tx(CUSTOMER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(batch::critical_review_ms());

        assert!(!batch::hold_escalated(&shared_batch), 0);
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        assert!(batch::hold_escalated(&shared_batch), 1);

        let history = batch::hold_history(&shared_batch);
        let last = history.borrow(history.length() - 1);
        assert!(batch::hold_record_escalated(last), 2);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 31 == batch::EHoldAlreadyEscalated.
#[test, expected_failure(abort_code = 31)]
fun test_escalate_stale_hold_rejects_double_escalation() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-033");

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Critical stop-sale",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-033",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(CUSTOMER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(batch::critical_review_ms());
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        // Already escalated — a second call must abort, not double-flag.
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_new_hold_resets_escalation_flag() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-034");

    // Place, escalate, and release a critical hold.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"First critical hold",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-034A",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };
    scenario.next_tx(CUSTOMER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(batch::critical_review_ms());
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        assert!(batch::hold_escalated(&shared_batch), 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::propose_release(&registry, &mut shared_batch, b"Proposing release", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };
    scenario.next_tx(MANUFACTURER);
    {
        // Onboard a second regulator so confirm_release has a different signer.
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_regulator(&admin_registry, &mut registry, PHARMACY, ctx);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(registry);
    };
    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_release(&registry, &mut shared_batch, &clock, ctx);
        // Release resets the current escalation flag.
        assert!(!batch::hold_escalated(&shared_batch), 1);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    // A brand-new hold starts unescalated even though the old one was.
    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Second, unrelated hold",
            batch::severity_advisory(),
            batch::category_other(),
            b"CASE-2026-034B",
            &clock,
            ctx,
        );
        assert!(!batch::hold_escalated(&shared_batch), 2);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_report_suspicion_does_not_change_batch_state() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-035");

    // Anyone -- not just a regulator -- can leave a tip. It's read-only:
    // the batch's hold state is untouched, this only emits an event and
    // shares a bonded SuspicionReport object.
    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let bond = coin::mint_for_testing<SUI>(batch::min_suspicion_bond(), ctx);
        batch::report_suspicion(&shared_batch, b"Seal looked tampered with", bond, &clock, ctx);
        assert!(!batch::is_held(&shared_batch), 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(CUSTOMER);
    {
        let report = scenario.take_shared<SuspicionReport>();
        assert!(batch::suspicion_report_reporter(&report) == CUSTOMER, 1);
        assert!(batch::suspicion_report_bond_amount(&report) == batch::min_suspicion_bond(), 2);
        test_scenario::return_shared(report);
    };

    scenario.end();
}

// abort_code 33 == batch::EEmptySuspicionNote.
#[test, expected_failure(abort_code = 33)]
fun test_report_suspicion_rejects_empty_note() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-036");

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let bond = coin::mint_for_testing<SUI>(batch::min_suspicion_bond(), ctx);
        batch::report_suspicion(&shared_batch, b"", bond, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 40 == batch::EBondTooSmall.
#[test, expected_failure(abort_code = 40)]
fun test_report_suspicion_rejects_bond_below_minimum() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-047");

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        // One MIST below the minimum — a bond that's technically nonzero
        // but not large enough to be a real deterrent.
        let bond = coin::mint_for_testing<SUI>(batch::min_suspicion_bond() - 1, ctx);
        batch::report_suspicion(&shared_batch, b"Trying a tiny bond", bond, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

/// Registers a batch with a nonzero stake, for the slash/withdraw tests.
fun setup_staked_batch(
    scenario: &mut test_scenario::Scenario,
    batch_code: vector<u8>,
    expiry_ms: u64,
    stake_amount: u64,
) {
    {
        let ctx = scenario.ctx();
        batch::test_init(ctx);
    };
    scenario.next_tx(MANUFACTURER);
    {
        let registry = scenario.take_shared<ManufacturerRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let stake = coin::mint_for_testing<SUI>(stake_amount, ctx);
        batch::create_batch(&registry, batch_code, b"Amoxicillin 500mg", expiry_ms, stake, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };
}

#[test]
fun test_place_critical_counterfeit_hold_slashes_stake_to_regulator() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-037", FAR_FUTURE_MS, 500);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        assert!(batch::stake_amount(&shared_batch) == 500, 0);

        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Confirmed counterfeit packaging",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-037",
            &clock,
            ctx,
        );

        // The stake is gone from the batch -- it was transferred out to
        // the regulator (MANUFACTURER here, since they placed the hold on
        // their own batch in this test -- the point being: whoever calls
        // place_hold with this exact combination receives it).
        assert!(batch::stake_amount(&shared_batch) == 0, 1);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    // Confirm the slashed coin actually landed in the regulator's wallet.
    scenario.next_tx(MANUFACTURER);
    {
        let slashed = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&slashed) == 500, 2);
        test_scenario::return_to_sender(&scenario, slashed);
    };

    scenario.end();
}

#[test]
fun test_critical_cold_chain_hold_partially_slashes_stake() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-038", FAR_FUTURE_MS, 500);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        // Critical, but a cold-chain breach rather than counterfeit --
        // real manufacturer fault, but not fraud, so this slashes at the
        // lower 50% rate (`slash_percent`) rather than the full 100% a
        // confirmed counterfeit finding carries, and rather than nothing
        // at all.
        assert!(batch::stake_slash_percent(batch::severity_critical(), batch::category_cold_chain_breach()) == 50, 9);
        batch::place_hold(
            &registry,
            &mut shared_batch,
            b"Refrigeration failure in transit",
            batch::severity_critical(),
            batch::category_cold_chain_breach(),
            b"CASE-2026-038",
            &clock,
            ctx,
        );

        assert!(batch::stake_amount(&shared_batch) == 250, 0);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun test_withdraw_stake_after_expiry_with_no_counterfeit_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-039", 1_000, 700);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(1_001); // past expiry_ms of 1_000

        batch::withdraw_stake(&mut shared_batch, &clock, ctx);
        assert!(batch::stake_amount(&shared_batch) == 0, 0);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let refund = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == 700, 1);
        test_scenario::return_to_sender(&scenario, refund);
    };

    scenario.end();
}

// abort_code 35 == batch::EStakeLockedUntilExpiry.
#[test, expected_failure(abort_code = 35)]
fun test_withdraw_stake_rejects_before_expiry() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-040", FAR_FUTURE_MS, 700);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::withdraw_stake(&mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 34 == batch::ENotBatchManufacturer ("not *this batch's*
// manufacturer" -- distinct from ENotManufacturer, which gates
// create_batch against the ManufacturerRegistry).
#[test, expected_failure(abort_code = 34)]
fun test_withdraw_stake_rejects_non_manufacturer() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-041", 1_000, 700);

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(1_001);
        batch::withdraw_stake(&mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 36 == batch::EStakeAlreadyEmpty.
#[test, expected_failure(abort_code = 36)]
fun test_withdraw_stake_rejects_double_withdraw() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-042", 1_000, 700);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(1_001);
        batch::withdraw_stake(&mut shared_batch, &clock, ctx);
        batch::withdraw_stake(&mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 37 == batch::ENotPharmacy.
#[test, expected_failure(abort_code = 37)]
fun test_mint_unit_rejects_non_pharmacy() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-043");

    // CUSTOMER was never onboarded as a pharmacy — unlike PHARMACY, which
    // `setup_batch` seeds automatically.
    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

#[test]
fun test_admin_add_pharmacy_lets_new_holder_mint_unit() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-044");

    scenario.next_tx(MANUFACTURER);
    {
        let admin_registry = scenario.take_shared<AdminRegistry>();
        let mut pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        batch::admin_add_pharmacy(&admin_registry, &mut pharmacy_registry, CUSTOMER, ctx);
        assert!(batch::is_pharmacy(&pharmacy_registry, CUSTOMER), 0);
        test_scenario::return_shared(admin_registry);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let pharmacy_registry = scenario.take_shared<PharmacyRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&pharmacy_registry, &shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
        test_scenario::return_shared(pharmacy_registry);
    };

    scenario.end();
}

#[test]
fun test_confirm_suspicion_refunds_bond_to_reporter() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-045");

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let bond = coin::mint_for_testing<SUI>(batch::min_suspicion_bond(), ctx);
        batch::report_suspicion(&shared_batch, b"Blister pack colour looked off", bond, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let report = scenario.take_shared<SuspicionReport>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_suspicion(report, &registry, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(CUSTOMER);
    {
        let refund = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == batch::min_suspicion_bond(), 0);
        test_scenario::return_to_sender(&scenario, refund);
    };

    scenario.end();
}

#[test]
fun test_reject_suspicion_forfeits_bond_to_regulator() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_with_registry(&mut scenario, b"BATCH-2026-046");

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let bond = coin::mint_for_testing<SUI>(batch::min_suspicion_bond(), ctx);
        batch::report_suspicion(&shared_batch, b"Just seemed off, no real reason", bond, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let report = scenario.take_shared<SuspicionReport>();
        let registry = scenario.take_shared<RegulatorRegistry>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::reject_suspicion(report, &registry, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let forfeited = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&forfeited) == batch::min_suspicion_bond(), 0);
        test_scenario::return_to_sender(&scenario, forfeited);
    };

    scenario.end();
}
