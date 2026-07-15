// SuiHub Lagos — Day 3: Programmable Tunnels (teaching package)
// SPDX-License-Identifier: MIT

/// A faithful, slimmed **payment channel** ("tunnel") modeled on the real
/// deployed 6M-TPS tunnel contract. It captures the core state-channel pattern
/// that the throughput claim rests on:
///
/// - Two parties open a funded, shared `Tunnel` on-chain (a deposit each).
/// - They then transact **off-chain**: each new balance split is a `StateCommitment`
///   { nonce, balances, state_hash } that BOTH parties sign. Throughput is bounded
///   by how fast they can sign messages — the chain is not touched per update.
/// - To finish, either they **cooperatively close** with the latest co-signed state
///   (one on-chain tx), or — if a party vanishes or cheats — the counterparty
///   **raises a dispute**, and the highest-nonce co-signed state wins after a timeout.
///
/// The monotonic `nonce` is the whole game: an old state can always be beaten by a
/// newer co-signed one, so posting a stale balance on-chain is pointless.
///
/// ### State Machine:
///
/// Created → Active → Closed          (cooperative path)
/// Created → Active → Disputed(deadline) → Closed   (unilateral path)
module tunnels_edu::channel;

use sui::balance::{Self, Balance};
use sui::bcs;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::ed25519;
use sui::event::emit;
use sui::sui::SUI;

// === Structs ===

/// A party's on-chain identity + the ed25519 public key their off-chain
/// signatures are checked against.
public struct PartyConfig has copy, drop, store {
    addr: address,
    public_key: vector<u8>,
}

/// The agreed balance split at a point in time. `nonce` strictly orders these;
/// `state_hash` binds an app-level transcript (the messages/moves) for privacy.
public struct StateCommitment has copy, drop, store {
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
}

/// Exactly the bytes both parties sign off-chain. Mirrored byte-for-byte by the
/// client (BCS) so the same message verifies here. Bound to `tunnel_id` so a
/// signature from one channel can't be replayed in another.
public struct StateUpdateData has copy, drop {
    tunnel_id: ID,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
}

public struct Tunnel has key {
    id: UID,
    party_a: PartyConfig,
    party_b: PartyConfig,
    balance: Balance<SUI>,
    party_a_deposit: u64,
    party_b_deposit: u64,
    state: StateCommitment,
    status: Status,
    created_at: u64,
    last_activity: u64,
    timeout_ms: u64,
}

// === Enums ===

public enum Status has copy, drop, store {
    Created,
    Active,
    /// A dispute is open; after this deadline (ms) anyone can finalize the tunnel
    /// at the current (highest-nonce) state.
    Disputed(u64),
    Closed,
}

// === Events ===

public struct TunnelCreated has copy, drop {
    tunnel_id: ID,
    party_a: address,
    party_b: address,
    created_at: u64,
}

public struct TunnelActivated has copy, drop {
    tunnel_id: ID,
    total: u64,
    activated_at: u64,
}

public struct DisputeRaised has copy, drop {
    tunnel_id: ID,
    raised_by: address,
    nonce: u64,
    deadline_ms: u64,
}

public struct DisputeAdvanced has copy, drop {
    tunnel_id: ID,
    nonce: u64,
}

public struct TunnelClosed has copy, drop {
    tunnel_id: ID,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    closed_at: u64,
}

// === Errors ===
// State errors (10-19)
const ENotCreated: u64 = 10;
const ENotActive: u64 = 11;
const ENotDisputed: u64 = 12;

// Validation errors (20-29)
const EBadSignatureA: u64 = 20;
const EBadSignatureB: u64 = 21;
const ENonceNotHigher: u64 = 22;
const EBalanceMismatch: u64 = 23;

// Constraint errors (30-39)
const EDisputeStillOpen: u64 = 30;
const EDisputeWindowClosed: u64 = 31;
const ENotAParty: u64 = 32;

// === Public Functions ===

/// Open a tunnel between two parties and share it. Funding comes next, via `deposit`.
public fun create_and_share(
    party_a: address,
    public_key_a: vector<u8>,
    party_b: address,
    public_key_b: vector<u8>,
    timeout_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let now = clock.timestamp_ms();
    let tunnel = Tunnel {
        id: object::new(ctx),
        party_a: PartyConfig { addr: party_a, public_key: public_key_a },
        party_b: PartyConfig { addr: party_b, public_key: public_key_b },
        balance: balance::zero(),
        party_a_deposit: 0,
        party_b_deposit: 0,
        state: StateCommitment {
            state_hash: b"",
            nonce: 0,
            timestamp: now,
            party_a_balance: 0,
            party_b_balance: 0,
        },
        status: Status::Created,
        created_at: now,
        last_activity: now,
        timeout_ms,
    };
    emit(TunnelCreated {
        tunnel_id: tunnel.id.to_inner(),
        party_a,
        party_b,
        created_at: now,
    });
    transfer::share_object(tunnel);
}

/// Fund your side. Once both parties have funded, the tunnel activates and its
/// starting state is the deposits themselves.
public fun deposit(self: &mut Tunnel, payment: Coin<SUI>, clock: &Clock, ctx: &TxContext) {
    assert!(self.is_created(), ENotCreated);
    let sender = ctx.sender();
    let amount = payment.value();
    self.balance.join(payment.into_balance());
    if (sender == self.party_a.addr) {
        self.party_a_deposit = self.party_a_deposit + amount;
    } else if (sender == self.party_b.addr) {
        self.party_b_deposit = self.party_b_deposit + amount;
    } else {
        abort ENotAParty
    };
    self.last_activity = clock.timestamp_ms();

    if (self.party_a_deposit > 0 && self.party_b_deposit > 0) {
        self.status = Status::Active;
        self.state.party_a_balance = self.party_a_deposit;
        self.state.party_b_balance = self.party_b_deposit;
        emit(TunnelActivated {
            tunnel_id: self.id.to_inner(),
            total: self.party_a_deposit + self.party_b_deposit,
            activated_at: self.last_activity,
        });
    }
}

/// Happy path: settle at a state BOTH parties signed off-chain. One on-chain tx
/// ends the channel; every update before this stayed off-chain.
public fun close_cooperative(
    self: &mut Tunnel,
    party_a_balance: u64,
    party_b_balance: u64,
    nonce: u64,
    state_hash: vector<u8>,
    timestamp: u64,
    signature_a: vector<u8>,
    signature_b: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(self.is_active(), ENotActive);
    self.assert_cosigned(state_hash, nonce, timestamp, party_a_balance, party_b_balance, signature_a, signature_b);
    assert!(nonce >= self.state.nonce, ENonceNotHigher);
    self.commit_state(state_hash, nonce, timestamp, party_a_balance, party_b_balance);
    self.settle(clock, ctx);
}

/// Unilateral path, step 1: post the latest co-signed state you hold and start the
/// dispute clock. The counterparty can still override with a higher nonce.
public fun raise_dispute(
    self: &mut Tunnel,
    party_a_balance: u64,
    party_b_balance: u64,
    nonce: u64,
    state_hash: vector<u8>,
    timestamp: u64,
    signature_a: vector<u8>,
    signature_b: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(self.is_active(), ENotActive);
    let sender = ctx.sender();
    assert!(sender == self.party_a.addr || sender == self.party_b.addr, ENotAParty);
    self.assert_cosigned(state_hash, nonce, timestamp, party_a_balance, party_b_balance, signature_a, signature_b);
    assert!(nonce >= self.state.nonce, ENonceNotHigher);
    self.commit_state(state_hash, nonce, timestamp, party_a_balance, party_b_balance);
    let deadline = clock.timestamp_ms() + self.timeout_ms;
    self.status = Status::Disputed(deadline);
    emit(DisputeRaised {
        tunnel_id: self.id.to_inner(),
        raised_by: sender,
        nonce,
        deadline_ms: deadline,
    });
}

/// Unilateral path, step 2: beat a stale posted state with a higher-nonce co-signed
/// one, before the deadline. This is what makes cheating pointless.
public fun resolve_dispute(
    self: &mut Tunnel,
    party_a_balance: u64,
    party_b_balance: u64,
    nonce: u64,
    state_hash: vector<u8>,
    timestamp: u64,
    signature_a: vector<u8>,
    signature_b: vector<u8>,
    clock: &Clock,
) {
    let deadline = self.dispute_deadline();
    assert!(clock.timestamp_ms() <= deadline, EDisputeWindowClosed);
    self.assert_cosigned(state_hash, nonce, timestamp, party_a_balance, party_b_balance, signature_a, signature_b);
    assert!(nonce > self.state.nonce, ENonceNotHigher);
    self.commit_state(state_hash, nonce, timestamp, party_a_balance, party_b_balance);
    emit(DisputeAdvanced { tunnel_id: self.id.to_inner(), nonce });
}

/// Unilateral path, step 3: after the deadline with no higher state posted,
/// finalize at the current (highest-nonce) state. Anyone can call it.
public fun force_close(self: &mut Tunnel, clock: &Clock, ctx: &mut TxContext) {
    let deadline = self.dispute_deadline();
    assert!(clock.timestamp_ms() > deadline, EDisputeStillOpen);
    self.settle(clock, ctx);
}

// === View Functions ===

public fun id(self: &Tunnel): ID { self.id.to_inner() }

public fun total_balance(self: &Tunnel): u64 { self.balance.value() }

public fun party_a_deposit(self: &Tunnel): u64 { self.party_a_deposit }

public fun party_b_deposit(self: &Tunnel): u64 { self.party_b_deposit }

public fun nonce(self: &Tunnel): u64 { self.state.nonce }

public fun party_a_balance(self: &Tunnel): u64 { self.state.party_a_balance }

public fun party_b_balance(self: &Tunnel): u64 { self.state.party_b_balance }

public fun is_created(self: &Tunnel): bool {
    match (&self.status) { Status::Created => true, _ => false }
}

public fun is_active(self: &Tunnel): bool {
    match (&self.status) { Status::Active => true, _ => false }
}

public fun is_disputed(self: &Tunnel): bool {
    match (&self.status) { Status::Disputed(_) => true, _ => false }
}

public fun is_closed(self: &Tunnel): bool {
    match (&self.status) { Status::Closed => true, _ => false }
}

/// The exact message both parties sign for a given state — exposed so clients can
/// reproduce it and confirm they're signing what the contract will verify.
public fun state_message(
    self: &Tunnel,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
): vector<u8> {
    bcs::to_bytes(&StateUpdateData {
        tunnel_id: self.id.to_inner(),
        state_hash,
        nonce,
        timestamp,
        party_a_balance,
        party_b_balance,
    })
}

// === Private Helpers ===

fun assert_cosigned(
    self: &Tunnel,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    signature_a: vector<u8>,
    signature_b: vector<u8>,
) {
    assert!(party_a_balance + party_b_balance == self.party_a_deposit + self.party_b_deposit, EBalanceMismatch);
    let msg = self.state_message(state_hash, nonce, timestamp, party_a_balance, party_b_balance);
    assert!(ed25519::ed25519_verify(&signature_a, &self.party_a.public_key, &msg), EBadSignatureA);
    assert!(ed25519::ed25519_verify(&signature_b, &self.party_b.public_key, &msg), EBadSignatureB);
}

fun commit_state(
    self: &mut Tunnel,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
) {
    self.state = StateCommitment { state_hash, nonce, timestamp, party_a_balance, party_b_balance };
    self.last_activity = timestamp;
}

fun settle(self: &mut Tunnel, clock: &Clock, ctx: &mut TxContext) {
    let a_amount = self.state.party_a_balance;
    let coin_a = coin::from_balance(self.balance.split(a_amount), ctx);
    let coin_b = coin::from_balance(self.balance.withdraw_all(), ctx);
    transfer::public_transfer(coin_a, self.party_a.addr);
    transfer::public_transfer(coin_b, self.party_b.addr);
    self.status = Status::Closed;
    emit(TunnelClosed {
        tunnel_id: self.id.to_inner(),
        party_a_balance: self.state.party_a_balance,
        party_b_balance: self.state.party_b_balance,
        final_nonce: self.state.nonce,
        closed_at: clock.timestamp_ms(),
    });
}

fun dispute_deadline(self: &Tunnel): u64 {
    match (&self.status) {
        Status::Disputed(deadline) => *deadline,
        _ => abort ENotDisputed,
    }
}

// === Test Only ===
// The co-signed paths require real ed25519 signatures over the runtime tunnel_id,
// so they're exercised by the on-chain e2e (scripts/tunnel-e2e.mjs). These helpers
// let the unit tests drive the state machine directly.

#[test_only]
public fun test_open_dispute(
    self: &mut Tunnel,
    party_a_balance: u64,
    party_b_balance: u64,
    nonce: u64,
    deadline_ms: u64,
) {
    self.state.party_a_balance = party_a_balance;
    self.state.party_b_balance = party_b_balance;
    self.state.nonce = nonce;
    self.status = Status::Disputed(deadline_ms);
}
