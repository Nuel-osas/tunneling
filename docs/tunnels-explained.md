# Programmable Tunnels on Sui — End to End

A teaching reference for **state channels ("programmable tunnels")** on Sui — the
pattern behind the **6,086,766 TPS** experiment of July 2026. Taught honestly:
there is **no public Tunnels SDK or docs**, so we do something better than follow a
tutorial — the experiment *settled on-chain*, so the real contract is public, and we
**reverse-engineer it** and rebuild the core ourselves.

---

## 0. The one-paragraph mental model

Two parties lock funds into a shared **`Tunnel`** on-chain (one transaction). From
then on they transact by exchanging **co-signed balance updates off-chain** — each
update is a `{ nonce, party_a_balance, party_b_balance, state_hash }` that **both
parties sign**. No update touches the chain: throughput is bounded only by **how fast
they can sign messages**. To finish, either they **cooperatively close** by
submitting the latest co-signed state (one transaction), or — if someone vanishes or
cheats — a party **raises a dispute** and the **highest-nonce co-signed state wins**
after a timeout. The monotonic `nonce` is the whole game: a stale state is always
beaten by a newer one, so posting an old balance on-chain is pointless.

> **The chain is a court, not a cashier.** It's touched to *open*, to *settle*, and
> to *resolve disputes* — never for the millions of updates in between.

---

## 1. Honest framing — why we reverse-engineer

Programmable Tunnels is **not a released, SDK-backed product**. But the 6M-TPS
experiment settled to Sui, which means the real Move contract is deployed and public.

- **Real contract (testnet, not mainnet — it was an experiment):**
  `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c`
- **8 modules:** `tunnel` (the core), `hop`, `referee`, `zk_verifier`, `signature`,
  `randomness`, `arena_domain`, `errors`.

We pull its ABI straight off-chain (`docs/real-tunnel-abi.json`), read the actual
functions, and rebuild the core faithfully (`tunnels_edu::channel`). Reading a live
protocol off the chain when there's no SDK is a rarer, stronger skill than following
docs that don't exist.

---

## 2. What "6M TPS" actually means (precise, not hypey)

The number is **real** and also **not what it sounds like**. It is not 6M
*base-layer* transactions per second. It's 6M **off-chain, co-signed state updates**
per second across many channels — each a message two parties sign, verified against
each other, never submitted to consensus. Sui's role is the **settlement + dispute
layer**: only channel *opens*, *closes*, and *disputes* are on-chain.

| | On-chain (consensus) | Off-chain (the tunnel) |
|---|---|---|
| Open a channel | ✅ 1 tx | — |
| Each balance update | — | ✅ 2 signatures, no tx |
| Settle | ✅ 1 tx | — |
| Dispute | ✅ a few txs | — |

So the honest claim: **the throughput ceiling is signature verification, not block
production.** Sui makes it practical because settlement is cheap, parallel (per-object
`Tunnel`), and has native signature + Groth16 verification.

---

## 3. What is hidden vs. public

| Public (on-chain) | Off-chain (only the two parties) |
|---|---|
| That a channel exists; the two parties; total locked | Every intermediate balance and update |
| The **final** settled balances | The **moves/messages** behind them (only their `state_hash` is committed) |
| Disputes (posted states + nonces) | The full transcript (a Merkle root can settle without revealing moves) |

`close_cooperative_with_root` settles against a **Merkle transcript root**, so the
individual off-chain moves stay hashed — final balances settle, the play-by-play does not.

---

## 4. The real contract's architecture (from its ABI)

### Core objects

- **`Tunnel`** (shared): `party_a`/`party_b: PartyConfig`, a pooled `Balance`,
  `party_a_deposit`/`party_b_deposit`, `state: StateCommitment`, `status`, `timeout_ms`,
  `penalty_amount`, `dispute_raiser`, `last_disputed_nonce`, `version`.
- **`StateCommitment`**: `{ state_hash, nonce, timestamp, party_a_balance, party_b_balance }`.
- **`PartyConfig`**: `{ address, public_key, signature_type }` — the key each party's
  off-chain signatures are verified against (ed25519 / others via `signature_type`).

### Lifecycle functions (verbatim shape)

```
create_and_share(a, pk_a, sigtype_a, b, pk_b, sigtype_b, timeout, penalty, &Clock, &mut ctx)
create_and_fund(... , Coin, Coin, ...)                 // open + fund atomically
deposit(&mut Tunnel, Coin, &Clock, &ctx)
update_state(&mut Tunnel, state_hash, nonce, ts, balA, balB, sigA, sigB, &Clock)  // co-signed checkpoint
close_cooperative(&mut Tunnel, balA, balB, state_hash, sigA, sigB, nonce, &Clock, &mut ctx)
close_cooperative_with_root(... , transcript_root, ...)   // settle w/ Merkle root, moves stay hashed
```

### Dispute court

```
raise_dispute(&mut Tunnel, state_hash, nonce, ts, balA, balB, sigA, &Clock, &ctx)  // post your latest
resolve_dispute(&mut Tunnel, ... , sigA, sigB, &Clock)          // beat it with a higher nonce
resolve_dispute_external(&mut Tunnel, balA, balB, &Clock, &ctx) // referee decides
force_close_after_timeout(&mut Tunnel, &Clock, &mut ctx)        // finalize at highest nonce
```

`penalty_amount` lets a party who posts a state that is then overridden be penalized —
a graduated disincentive against cheating.

### The other modules

- **`hop` + HTLC** (`lock_htlc` / `claim_htlc_in_tunnel` / `expire_htlc`): hash-time-locked
  contracts for **conditional, multi-hop routing** — the Lightning-style trick that lets
  a payment traverse several channels atomically.
- **`referee`**: an optional trusted third party who can resolve a dispute directly.
- **`zk_verifier`**: **Groth16** verification — a dispute can be settled by a **ZK proof**
  of the correct state instead of a referee.
- **`signature`**: multi-scheme signature verification. **`randomness`**, **`arena_domain`**:
  the game/experiment domain the 6M-TPS run used. **`errors`**: shared error codes.
- **`version` / `migrate`**: the shared object is upgradeable.

---

## 5. Our faithful mini-version — `tunnels_edu::channel`

Testnet package: `0x9bd35322a0e12f0339f7af281838e0ae40ce15238c3a75b55cae8e421afc1c4e`.

**Mirrors the real core:** `Tunnel` / `StateCommitment` / `PartyConfig`, ed25519
co-signed updates, `close_cooperative`, `raise_dispute` → `resolve_dispute` →
`force_close`, monotonic nonce, and a **balance-conservation** check
(`party_a_balance + party_b_balance == total deposits`).

**Slimmed for teaching:** SUI-only (vs a generic coin), no HTLC/hop, no referee, no
ZK verifier, and a simple **dispute-by-higher-nonce** court instead of the full
graduated-penalty machinery. The point is the pattern, not the production surface.

### The co-signed state message (the crux)

Both parties sign the **exact same bytes**, and the contract verifies them. The client
BCS-serializes a struct identical to Move's, and the signature is **bound to the
`tunnel_id`** so a signature from one channel can never be replayed in another:

```move
// Move — what the contract hashes/verifies
public struct StateUpdateData has copy, drop {
    tunnel_id: ID,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
}
// state_message() exposes bcs::to_bytes(&StateUpdateData{...}) so clients can confirm
// they are signing exactly what update/close/dispute will verify.
```

```ts
// Client — byte-for-byte identical (BCS), then both parties ed25519-sign it
const StateUpdateData = bcs.struct("StateUpdateData", {
  tunnel_id: bcs.Address, state_hash: bcs.vector(bcs.u8()),
  nonce: bcs.u64(), timestamp: bcs.u64(),
  party_a_balance: bcs.u64(), party_b_balance: bcs.u64(),
});
const msg = StateUpdateData.serialize({ tunnel_id, state_hash, nonce, timestamp, a, b }).toBytes();
const sigA = await alice.sign(msg);   // raw ed25519 — matches sui::ed25519::ed25519_verify
const sigB = await bob.sign(msg);
```

On-chain, `assert_cosigned` checks **balance conservation**, then
`ed25519_verify(sigA, pk_a, msg)` **and** `ed25519_verify(sigB, pk_b, msg)`. Both
signatures, or it aborts.

---

## 6. The two settlement paths

**Cooperative close (happy path).** After N off-chain updates, either party submits
the latest co-signed state. One transaction pays out `party_a_balance` /
`party_b_balance` and closes. Everything before it stayed off-chain.

**Dispute (unilateral path).**

```
raise_dispute(latest you hold)  →  status = Disputed(deadline)
    counterparty: resolve_dispute(higher-nonce co-signed state)   // overrides, before deadline
    after deadline: force_close()  →  settle at the highest nonce seen
```

**Why a stale state is worthless:** `resolve_dispute` accepts only a **strictly higher
nonce**, and both parties signed every state — so whoever holds the newest co-signed
state can always beat an old one during the window. Cheating only works if your
counterparty is offline for the *entire* timeout (the liveness assumption).

---

## 7. It's not just payments

The balances can represent anything two parties agree on, and `state_hash` commits an
**off-chain transcript** that only settles at the end:

- **Payments** — high-frequency P2P transfer, streamed micropayments.
- **P2P gaming** — each move updates state off-chain; only the final score settles
  (this is literally what the 6M-TPS `arena_domain` run did).
- **Agent-to-agent** — autonomous agents pay/interact at signing speed, settle on-chain.
- **Chat / messaging** — `state_hash` commits the message transcript; the chain never
  sees the messages, only that both parties agreed.
- **Multi-hop routing** — HTLC/`hop` lets a payment cross several channels atomically
  (Lightning-style), so you don't need a direct channel with everyone.
- **Multi-party** — a "party" can be a **multisig** or an **Ika MPC dWallet**, so a
  channel side can be a group, not just one key.

---

## 8. Composability with the rest of the stack

- **Day 1 (Confidential):** settle a tunnel into a **confidential** balance — the final
  amounts are hidden while still provably correct.
- **Day 2 (Gasless):** the on-chain settlement/open can be **sponsored** (gas station),
  so a user opens and closes a channel without holding SUI. Native gasless doesn't
  apply (it's stablecoin-transfer-only), but sponsoring does.
- The tunnel is the **speed** layer; confidential is the **privacy** layer; gasless is
  the **UX** layer. Stack all three.

---

## 9. Edge cases & gotchas (where students trip)

| # | Case | Rule / what happens |
|---|---|---|
| 1 | **Nonce not higher** | `update`/`resolve` require a strictly higher (or ≥ for cooperative) nonce → `ENonceNotHigher`. Old states can't overwrite new ones. |
| 2 | **Balances don't conserve** | `party_a_balance + party_b_balance` must equal total deposits → `EBalanceMismatch`. You can't sign money into existence. |
| 3 | **Dispute window closed** | `resolve_dispute` after the deadline aborts (`EDisputeWindowClosed`). Watch the chain and override in time. |
| 4 | **Force-close too early** | `force_close` before the deadline aborts (`EDisputeStillOpen`). |
| 5 | **Non-party deposit** | Only the two parties may deposit → `ENotAParty`. |
| 6 | **Signature replay** | The signed message includes `tunnel_id`, so a co-signature from one channel is invalid in another. |
| 7 | **Wrong message bytes** | The client must BCS-serialize `StateUpdateData` **exactly** as Move does, or `ed25519_verify` fails. Use `state_message()` to confirm. |
| 8 | **Testnet reset / RPC** | Testnet wipes periodically — republish `move/` and repaste IDs. The public testnet fullnode 404s for JSON-RPC → pin `https://sui-testnet-rpc.publicnode.com`. |

---

## 10. Security model — one screen

- **Safety** rests on four checks, all on-chain at settlement: **both** signatures
  required, **monotonic nonce**, **balance conservation**, and the **dispute timeout**.
  Break any one and you break the channel.
- **Liveness** rests on **watching the chain**: if your counterparty raises a dispute
  with a stale state, you must `resolve_dispute` with a newer one **before the deadline**.
  Being offline for the whole timeout is the only way to lose funds you're owed — this
  is the classic state-channel "watchtower" assumption.
- **Decrypt ≠ authorize.** Knowing a state lets you *propose* it; only a state signed by
  **both** parties can settle.
- **Trust assumptions:** unaudited teaching code; the real contract adds a referee and a
  Groth16 ZK path so disputes can be resolved without a trusted watchtower.

---

## 11. Cheat-sheet

**Objects:** `Tunnel` (shared) · `StateCommitment {state_hash, nonce, ts, balA, balB}` ·
`PartyConfig {addr, public_key}`.

**Lifecycle:** `create_and_share` → `deposit` ×2 (→ Active) → **[off-chain co-signed
updates]** → `close_cooperative`  **|**  `raise_dispute` → `resolve_dispute` →
`force_close`.

**The rule:** both signatures + higher nonce + balances conserve. Stale states lose.

**Message:** `bcs(StateUpdateData{tunnel_id, state_hash, nonce, ts, balA, balB})`,
ed25519-signed by both, bound to `tunnel_id`.

**Verified on testnet:** teaching pkg
`0x9bd35322a0e12f0339f7af281838e0ae40ce15238c3a75b55cae8e421afc1c4e` ·
cooperative settle `5adsxYTz6Vviqvvk5DdnooYvsXALrmw8wU9PyCHktdpS` ·
dispute force-close `813E5uFQJEcrV5fZ8c1Bbw2Wrxst2xf63sK1AauV858u` ·
real contract `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c`.
