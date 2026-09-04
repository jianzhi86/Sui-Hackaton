#[test_only]
module pharma_track::batch_tests;

use pharma_track::batch::{Self, Batch, SuspicionReport, Unit};
use std::hash;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;

const MANUFACTURER: address = @0xA11CE;
const DISTRIBUTOR: address = @0xB0B;
const PHARMACY: address = @0xCAFE;
const CUSTOMER: address = @0xD00D;
const REGULATOR_A: address = @0xF00D;
const REGULATOR_B: address = @0xBEEF;

/// Far enough out that no test's clock manipulation will accidentally
/// cross it — used everywhere a test doesn't care about expiry itself.
const FAR_FUTURE_MS: u64 = 4_102_444_800_000; // year 2100

/// A stand-in one-time scratch-off code, used everywhere a test needs
/// `mint_unit`/`purchase_and_burn`'s secret but isn't specifically testing
/// the secret-mismatch behavior.
const TEST_SECRET: vector<u8> = b"scratch-code-1234";

/// Registers a batch with no stake. No access control exists anywhere in
/// this module — `create_batch` is callable directly by whoever the
/// scenario's current sender is, no setup/onboarding step needed.
fun setup_batch(scenario: &mut test_scenario::Scenario, batch_code: vector<u8>, expiry_ms: u64) {
    let ctx = scenario.ctx();
    let clock = clock::create_for_testing(ctx);
    batch::create_batch(batch_code, b"Amoxicillin 500mg", expiry_ms, coin::zero<SUI>(ctx), &clock, ctx);
    clock.destroy_for_testing();
}

/// `setup_batch` with a far-future expiry, for tests that aren't about
/// expiry at all (most of the hold/sale tests).
fun setup_batch_far_future(scenario: &mut test_scenario::Scenario, batch_code: vector<u8>) {
    setup_batch(scenario, batch_code, FAR_FUTURE_MS);
}

/// Registers a batch with a nonzero stake, for the slash/withdraw/top-up
/// tests.
fun setup_staked_batch(
    scenario: &mut test_scenario::Scenario,
    batch_code: vector<u8>,
    expiry_ms: u64,
    stake_amount: u64,
) {
    let ctx = scenario.ctx();
    let clock = clock::create_for_testing(ctx);
    let stake = coin::mint_for_testing<SUI>(stake_amount, ctx);
    batch::create_batch(batch_code, b"Amoxicillin 500mg", expiry_ms, stake, &clock, ctx);
    clock.destroy_for_testing();
}

// ===== create_batch / add_checkpoint =====

#[test]
fun test_create_batch_and_add_checkpoint() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-001");

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
        let checkpoints = batch::checkpoints(&shared_batch);
        let first = checkpoints.borrow(0);
        assert!(batch::checkpoint_actor(first) == DISTRIBUTOR, 1);
        assert!(batch::checkpoint_role(first) == b"distributor".to_string(), 2);
        assert!(batch::checkpoint_has_temperature(first), 3);
        assert!(batch::checkpoint_temperature_c_offset(first) == batch::temperature_offset_c() + 5, 4);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 0 == batch::EEmptyBatchCode.
#[test, expected_failure(abort_code = 0)]
fun test_create_batch_rejects_empty_code() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(b"", b"Amoxicillin 500mg", FAR_FUTURE_MS, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
    };
    scenario.end();
}

// abort_code 23 == batch::EInvalidExpiry.
#[test, expected_failure(abort_code = 23)]
fun test_create_batch_rejects_expiry_in_the_past() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    {
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::create_batch(b"BATCH-2026-002", b"Amoxicillin 500mg", 0, coin::zero<SUI>(ctx), &clock, ctx);
        clock.destroy_for_testing();
    };
    scenario.end();
}

// abort_code 2 == batch::EBatchHeld.
#[test, expected_failure(abort_code = 2)]
fun test_add_checkpoint_aborts_while_held() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-003");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &mut shared_batch,
            b"Suspected counterfeit",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-003",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(DISTRIBUTOR);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::add_checkpoint(&mut shared_batch, b"distributor", b"KL Hub", b"", false, 0, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// ===== Holds =====

#[test]
fun test_hold_blocks_checkpoint_then_release_allows_it() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-004");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &mut shared_batch,
            b"Suspected counterfeit",
            batch::severity_recall(),
            batch::category_counterfeit(),
            b"CASE-2026-004",
            &clock,
            ctx,
        );
        assert!(batch::is_held(&shared_batch), 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::release_hold(&mut shared_batch, b"Confirmed genuine after investigation", &clock, ctx);
        assert!(!batch::is_held(&shared_batch), 1);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(DISTRIBUTOR);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::add_checkpoint(&mut shared_batch, b"distributor", b"KL Hub", b"", false, 0, &clock, ctx);
        assert!(batch::checkpoint_count(&shared_batch) == 1, 2);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_hold_history_records_every_cycle() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-005");

    let mut i: u64 = 0;
    while (i < 2) {
        scenario.next_tx(REGULATOR_A);
        {
            let mut shared_batch = scenario.take_shared<Batch>();
            let ctx = scenario.ctx();
            let clock = clock::create_for_testing(ctx);
            batch::place_hold(
                &mut shared_batch,
                b"Investigating",
                batch::severity_advisory(),
                batch::category_other(),
                b"CASE-2026-005",
                &clock,
                ctx,
            );
            batch::release_hold(&mut shared_batch, b"Cleared", &clock, ctx);
            clock.destroy_for_testing();
            test_scenario::return_shared(shared_batch);
        };
        i = i + 1;
    };

    scenario.next_tx(MANUFACTURER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let history = batch::hold_history(&shared_batch);
        assert!(history.length() == 2, 0);
        assert!(batch::hold_record_is_released(history.borrow(0)), 1);
        assert!(batch::hold_record_is_released(history.borrow(1)), 2);
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 9 == batch::EEmptyCaseReference.
#[test, expected_failure(abort_code = 9)]
fun test_place_hold_rejects_empty_case_reference() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-006");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Reason", batch::severity_advisory(), batch::category_other(), b"", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 19 == batch::EInvalidCategory.
#[test, expected_failure(abort_code = 19)]
fun test_place_hold_rejects_invalid_category() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-007");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Reason", batch::severity_advisory(), 99, b"CASE-007", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 8 == batch::EInvalidSeverity.
#[test, expected_failure(abort_code = 8)]
fun test_place_hold_rejects_invalid_severity() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-008");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Reason", 99, batch::category_other(), b"CASE-008", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 10 == batch::EEmptyReleaseNote.
#[test, expected_failure(abort_code = 10)]
fun test_release_hold_rejects_empty_note() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-009");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Reason", batch::severity_advisory(), batch::category_other(), b"CASE-009", &clock, ctx);
        batch::release_hold(&mut shared_batch, b"", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 12 == batch::ECriticalRequiresMultisig.
#[test, expected_failure(abort_code = 12)]
fun test_release_hold_rejects_single_signer_for_critical() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-010");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-010", &clock, ctx);
        batch::release_hold(&mut shared_batch, b"Nevermind", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 12 == batch::ECriticalRequiresMultisig.
#[test, expected_failure(abort_code = 12)]
fun test_propose_release_rejects_non_critical_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-011");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Reason", batch::severity_advisory(), batch::category_other(), b"CASE-011", &clock, ctx);
        batch::propose_release(&mut shared_batch, b"note", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 13 == batch::EReleaseAlreadyProposed.
#[test, expected_failure(abort_code = 13)]
fun test_propose_release_rejects_duplicate_proposal() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-012");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-012", &clock, ctx);
        batch::propose_release(&mut shared_batch, b"first", &clock, ctx);
        batch::propose_release(&mut shared_batch, b"second", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 14 == batch::ENoReleaseProposed.
#[test, expected_failure(abort_code = 14)]
fun test_confirm_release_rejects_without_proposal() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-013");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-013", &clock, ctx);
        batch::confirm_release(&mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 15 == batch::ESameRegulatorCannotConfirm.
#[test, expected_failure(abort_code = 15)]
fun test_confirm_release_rejects_same_address() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-014");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-014", &clock, ctx);
        batch::propose_release(&mut shared_batch, b"note", &clock, ctx);
        batch::confirm_release(&mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_propose_then_confirm_release_by_different_addresses_succeeds() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-015");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-015", &clock, ctx);
        batch::propose_release(&mut shared_batch, b"Independent lab confirmed genuine", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_B);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_release(&mut shared_batch, &clock, ctx);
        assert!(!batch::is_held(&shared_batch), 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// ===== escalate_stale_hold =====

#[test]
fun test_escalate_stale_hold_flags_overdue_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-016");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-016", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(CUSTOMER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(batch::critical_review_ms() + 1);
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        assert!(batch::hold_escalated(&shared_batch), 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 32 == batch::EHoldNotYetOverdue.
#[test, expected_failure(abort_code = 32)]
fun test_escalate_stale_hold_rejects_before_threshold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-017");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-017", &clock, ctx);
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 31 == batch::EHoldAlreadyEscalated.
#[test, expected_failure(abort_code = 31)]
fun test_escalate_stale_hold_rejects_double_escalation() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-018");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-018", &clock, ctx);
        clock.set_for_testing(batch::critical_review_ms() + 1);
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_new_hold_resets_escalation_flag() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-019");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-019", &clock, ctx);
        clock.set_for_testing(batch::critical_review_ms() + 1);
        batch::escalate_stale_hold(&mut shared_batch, &clock);
        batch::propose_release(&mut shared_batch, b"note", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_B);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_release(&mut shared_batch, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"New issue", batch::severity_advisory(), batch::category_other(), b"CASE-019B", &clock, ctx);
        assert!(!batch::hold_escalated(&shared_batch), 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// ===== mint_unit / purchase_and_burn =====

#[test, expected_failure(abort_code = 2)]
fun test_mint_unit_rejects_held_batch() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-020");

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-020", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 24 == batch::EBatchExpired.
#[test, expected_failure(abort_code = 24)]
fun test_mint_unit_rejects_expired_batch() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-021", 1_000);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(1_001);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 25 == batch::EInvalidSecretHash.
#[test, expected_failure(abort_code = 25)]
fun test_mint_unit_rejects_invalid_secret_hash_length() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-022");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, b"too-short", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_purchase_and_burn_pays_manufacturer_and_deletes_unit() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-023");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
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

    scenario.next_tx(MANUFACTURER);
    {
        let payment = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&payment) == 100, 0);
        test_scenario::return_to_sender(&scenario, payment);
    };

    scenario.end();
}

// abort_code 6 == batch::EWrongPayment.
#[test, expected_failure(abort_code = 6)]
fun test_purchase_and_burn_rejects_wrong_payment() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-024");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
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

// abort_code 7 == batch::EUnitExpired.
#[test, expected_failure(abort_code = 7)]
fun test_purchase_and_burn_rejects_expired_unit() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-025");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

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

// abort_code 2 == batch::EBatchHeld.
#[test, expected_failure(abort_code = 2)]
fun test_purchase_and_burn_rejects_batch_held_after_mint() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-026");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(&mut shared_batch, b"Confirmed counterfeit", batch::severity_critical(), batch::category_counterfeit(), b"CASE-026", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
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

// abort_code 24 == batch::EBatchExpired.
#[test, expected_failure(abort_code = 24)]
fun test_purchase_and_burn_rejects_batch_expired_after_mint() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch(&mut scenario, b"BATCH-2026-027", 1_000_000);

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(1_000_001);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 11 == batch::EUnitBatchMismatch.
#[test, expected_failure(abort_code = 11)]
fun test_purchase_and_burn_rejects_wrong_batch() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-028A");

    scenario.next_tx(PHARMACY);
    {
        let batch_a = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&batch_a, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(batch_a);
    };

    // Batch B is created — and therefore shared — after A was last
    // touched, so it's now unambiguously the "most recent" Batch.
    scenario.next_tx(MANUFACTURER);
    {
        setup_batch_far_future(&mut scenario, b"BATCH-2026-028B");
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let batch_b = test_scenario::most_recent_id_shared<Batch>();
        let batch_b = scenario.take_shared_by_id<Batch>(batch_b.destroy_some());
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &batch_b, payment, TEST_SECRET, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(batch_b);
    };

    scenario.end();
}

// abort_code 26 == batch::ESecretMismatch.
#[test, expected_failure(abort_code = 26)]
fun test_purchase_and_burn_rejects_wrong_secret() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-029");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(100, ctx);
        batch::purchase_and_burn(unit, &shared_batch, payment, b"wrong-code", &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test, expected_failure]
fun test_purchase_and_burn_cannot_be_redeemed_twice() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-030");

    scenario.next_tx(PHARMACY);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::mint_unit(&shared_batch, 100, hash::sha2_256(TEST_SECRET), &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
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

    // The Unit object no longer exists — attempting to take_shared it
    // again aborts, which is exactly the single-use guarantee.
    scenario.next_tx(CUSTOMER);
    {
        let unit = scenario.take_shared<Unit>();
        test_scenario::return_shared(unit);
    };

    scenario.end();
}

// ===== report_suspicion / confirm_suspicion / reject_suspicion =====

#[test]
fun test_report_suspicion_does_not_change_batch_state() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-031");

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
    setup_batch_far_future(&mut scenario, b"BATCH-2026-032");

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
    setup_batch_far_future(&mut scenario, b"BATCH-2026-033");

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let bond = coin::mint_for_testing<SUI>(batch::min_suspicion_bond() - 1, ctx);
        batch::report_suspicion(&shared_batch, b"Trying a tiny bond", bond, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_confirm_suspicion_refunds_bond_to_reporter() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-034");

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let bond = coin::mint_for_testing<SUI>(50_000_000, ctx);
        batch::report_suspicion(&shared_batch, b"Blister pack colour looked off", bond, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_A);
    {
        let report = scenario.take_shared<SuspicionReport>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::confirm_suspicion(report, &clock, ctx);
        clock.destroy_for_testing();
    };

    scenario.next_tx(CUSTOMER);
    {
        let refund = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == 50_000_000, 0);
        test_scenario::return_to_sender(&scenario, refund);
    };

    scenario.end();
}

#[test]
fun test_reject_suspicion_forfeits_bond_to_caller() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_batch_far_future(&mut scenario, b"BATCH-2026-035");

    scenario.next_tx(CUSTOMER);
    {
        let shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let bond = coin::mint_for_testing<SUI>(50_000_000, ctx);
        batch::report_suspicion(&shared_batch, b"Just seemed off, no real reason", bond, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_A);
    {
        let report = scenario.take_shared<SuspicionReport>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::reject_suspicion(report, &clock, ctx);
        clock.destroy_for_testing();
    };

    scenario.next_tx(REGULATOR_A);
    {
        let forfeited = scenario.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&forfeited) == 50_000_000, 0);
        test_scenario::return_to_sender(&scenario, forfeited);
    };

    scenario.end();
}

// ===== Stake: slash / withdraw / add =====

#[test]
fun test_place_critical_counterfeit_hold_slashes_stake_to_caller() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-036", FAR_FUTURE_MS, 500);

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        assert!(batch::stake_amount(&shared_batch) == 500, 0);

        batch::place_hold(
            &mut shared_batch,
            b"Confirmed counterfeit packaging",
            batch::severity_critical(),
            batch::category_counterfeit(),
            b"CASE-2026-036",
            &clock,
            ctx,
        );

        assert!(batch::stake_amount(&shared_batch) == 0, 1);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(REGULATOR_A);
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
    setup_staked_batch(&mut scenario, b"BATCH-2026-037", FAR_FUTURE_MS, 500);

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);

        assert!(batch::stake_slash_percent(batch::severity_critical(), batch::category_cold_chain_breach()) == 50, 9);
        batch::place_hold(
            &mut shared_batch,
            b"Refrigeration failure in transit",
            batch::severity_critical(),
            batch::category_cold_chain_breach(),
            b"CASE-2026-037",
            &clock,
            ctx,
        );

        assert!(batch::stake_amount(&shared_batch) == 250, 0);

        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

#[test]
fun test_withdraw_stake_after_expiry_with_no_counterfeit_hold() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-038", 1_000, 700);

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
    setup_staked_batch(&mut scenario, b"BATCH-2026-039", FAR_FUTURE_MS, 700);

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

// abort_code 34 == batch::ENotBatchManufacturer.
#[test, expected_failure(abort_code = 34)]
fun test_withdraw_stake_rejects_non_manufacturer() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-040", 1_000, 700);

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
    setup_staked_batch(&mut scenario, b"BATCH-2026-041", 1_000, 700);

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

#[test]
fun test_add_stake_tops_up_existing_collateral() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-042", FAR_FUTURE_MS, 500);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(300, ctx);
        batch::add_stake(&mut shared_batch, payment, &clock, ctx);
        assert!(batch::stake_amount(&shared_batch) == 800, 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 34 == batch::ENotBatchManufacturer.
#[test, expected_failure(abort_code = 34)]
fun test_add_stake_rejects_non_manufacturer() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-043", FAR_FUTURE_MS, 500);

    scenario.next_tx(PHARMACY);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(300, ctx);
        batch::add_stake(&mut shared_batch, payment, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 46 == batch::EZeroStakeTopUp.
#[test, expected_failure(abort_code = 46)]
fun test_add_stake_rejects_zero_payment() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-044", FAR_FUTURE_MS, 500);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(0, ctx);
        batch::add_stake(&mut shared_batch, payment, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 24 == batch::EBatchExpired.
#[test, expected_failure(abort_code = 24)]
fun test_add_stake_rejects_after_expiry() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-045", 1_000, 500);

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let mut clock = clock::create_for_testing(ctx);
        clock.set_for_testing(1_001);
        let payment = coin::mint_for_testing<SUI>(300, ctx);
        batch::add_stake(&mut shared_batch, payment, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}

// abort_code 2 == batch::EBatchHeld.
#[test, expected_failure(abort_code = 2)]
fun test_add_stake_rejects_while_held() {
    let mut scenario = test_scenario::begin(MANUFACTURER);
    setup_staked_batch(&mut scenario, b"BATCH-2026-046", FAR_FUTURE_MS, 500);

    scenario.next_tx(REGULATOR_A);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        batch::place_hold(
            &mut shared_batch,
            b"Investigating",
            batch::severity_advisory(),
            batch::category_other(),
            b"CASE-2026-046",
            &clock,
            ctx,
        );
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.next_tx(MANUFACTURER);
    {
        let mut shared_batch = scenario.take_shared<Batch>();
        let ctx = scenario.ctx();
        let clock = clock::create_for_testing(ctx);
        let payment = coin::mint_for_testing<SUI>(300, ctx);
        batch::add_stake(&mut shared_batch, payment, &clock, ctx);
        clock.destroy_for_testing();
        test_scenario::return_shared(shared_batch);
    };

    scenario.end();
}
