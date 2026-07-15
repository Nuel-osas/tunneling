// SPDX-License-Identifier: MIT
#[test_only]
module tunnels_edu::channel_tests;

use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use tunnels_edu::channel::{Self, Tunnel};

const ALICE: address = @0xA;
const BOB: address = @0xB;
const CAROL: address = @0xC;

const PK_A: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PK_B: vector<u8> = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fun open_tunnel(scn: &mut ts::Scenario): Tunnel {
    let clk = clock::create_for_testing(scn.ctx());
    channel::create_and_share(ALICE, PK_A, BOB, PK_B, 1000, &clk, scn.ctx());
    clk.destroy_for_testing();
    scn.next_tx(ALICE);
    scn.take_shared<Tunnel>()
}

fun fund(scn: &mut ts::Scenario, tunnel: &mut Tunnel, who: address, amount: u64) {
    scn.next_tx(who);
    let clk = clock::create_for_testing(scn.ctx());
    let c = coin::mint_for_testing<SUI>(amount, scn.ctx());
    tunnel.deposit(c, &clk, scn.ctx());
    clk.destroy_for_testing();
}

#[test]
fun test_open_fund_activate() {
    let mut scn = ts::begin(ALICE);
    let mut tunnel = open_tunnel(&mut scn);
    assert!(tunnel.is_created());

    fund(&mut scn, &mut tunnel, ALICE, 60);
    assert!(tunnel.is_created()); // only one side funded

    fund(&mut scn, &mut tunnel, BOB, 40);
    assert!(tunnel.is_active());
    assert!(tunnel.party_a_deposit() == 60);
    assert!(tunnel.party_b_deposit() == 40);
    assert!(tunnel.party_a_balance() == 60); // starting state == deposits
    assert!(tunnel.party_b_balance() == 40);
    assert!(tunnel.total_balance() == 100);

    ts::return_shared(tunnel);
    scn.end();
}

#[test, expected_failure(abort_code = tunnels_edu::channel::ENotAParty)]
fun test_stranger_cannot_deposit() {
    let mut scn = ts::begin(ALICE);
    let mut tunnel = open_tunnel(&mut scn);
    fund(&mut scn, &mut tunnel, CAROL, 10); // not a party
    abort 0
}

#[test, expected_failure(abort_code = tunnels_edu::channel::EDisputeStillOpen)]
fun test_force_close_before_deadline_aborts() {
    let mut scn = ts::begin(ALICE);
    let mut tunnel = open_tunnel(&mut scn);
    fund(&mut scn, &mut tunnel, ALICE, 60);
    fund(&mut scn, &mut tunnel, BOB, 40);

    // dispute opened with a far-future deadline
    tunnel.test_open_dispute(70, 30, 5, 10_000);

    scn.next_tx(ALICE);
    let clk = clock::create_for_testing(scn.ctx()); // time = 0 < deadline
    tunnel.force_close(&clk, scn.ctx());
    clk.destroy_for_testing();
    abort 0
}

#[test]
fun test_force_close_settles_at_final_state() {
    let mut scn = ts::begin(ALICE);
    let mut tunnel = open_tunnel(&mut scn);
    fund(&mut scn, &mut tunnel, ALICE, 60);
    fund(&mut scn, &mut tunnel, BOB, 40);

    // after several off-chain updates, the latest co-signed split is 70/30 at nonce 5
    tunnel.test_open_dispute(70, 30, 5, 1_000);

    scn.next_tx(ALICE);
    let mut clk = clock::create_for_testing(scn.ctx());
    clk.set_for_testing(2_000); // past the deadline
    tunnel.force_close(&clk, scn.ctx());
    assert!(tunnel.is_closed());
    clk.destroy_for_testing();

    // payouts landed at the final balances
    scn.next_tx(ALICE);
    let coin_a = scn.take_from_address<coin::Coin<SUI>>(ALICE);
    assert!(coin_a.value() == 70);
    scn.return_to_sender(coin_a);

    scn.next_tx(BOB);
    let coin_b = scn.take_from_address<coin::Coin<SUI>>(BOB);
    assert!(coin_b.value() == 30);
    ts::return_to_address(BOB, coin_b);

    ts::return_shared(tunnel);
    scn.end();
}
