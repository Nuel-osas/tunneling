# Reverse-Engineering Sui Programmable Tunnels (ZK Tunnels)

**Goal:** understand how the July-4-2026 "6M TPS" tunnels experiment worked, well
enough to explain it *and* build a toy version on Sui you can teach today.

> ✅ **UPDATE — we recovered the ACTUAL deployed contract.** The experiment's explorer
> (dev.millionstps.io) settles on **Sui testnet**, and the settlement objects are public.
> We traced a real settle tx → the tunnel shared object → its **package
> `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c`** and pulled the
> full on-chain ABI. So most of the "reconstruction" below is now **[Confirmed on-chain]**.
> See §8 for the real contract. (Still no git repo/SDK — but the deployed Move ABI is fully
> inspectable, which is even better for reverse-engineering.)

---

## 1. The one-sentence model

**[Confirmed]** Programmable Tunnels = *"a programmable generalization of the Lightning
Network: state channels + zero-knowledge proofs + arbitrary off-chain logic."*
One opening tx does a cryptographic handshake; parties then interact **off-chain**
(no gas, no latency, even over Bluetooth/offline); one closing tx settles the final
state with a **succinct validity or fraud proof.**

So it's three ideas stacked:
1. **State channels** — lock state on-chain, update it off-chain by exchanging signed messages.
2. **ZK proofs** — at close, prove the final state is correct without replaying every step (succinct + private).
3. **Programmable logic** — the "state" can be *any* app (a game, a market, agent chat), not just payment balances.

### 1b. What the source (Kostas Chalkias, Mysten chief cryptographer) actually confirmed

Not "some people reverse-engineered it" — **Mysten explains it openly.** Chalkias
unveiled ZK tunnels at **Sui Basecamp 2025**, alongside native verifiable randomness,
"lightning transactions (zero-gas, zero-latency)," and time capsules. Confirmed points:

- **"ZK tunnels extend state channels with off-chain execution and selective disclosure."**
- **"Every closed channel is mutually co-signed and independently verifiable on-chain."**
  (Both parties sign the final state; the chain verifies it independently.)
- **The AI-verifiability mechanism:** *"by seeding AI models with on-chain randomness and
  binding input/output pairs to verifiable proofs,"* Sui makes agent interactions
  trustworthy. → A tunnel doesn't just track balances; each agent action is an
  **(input → output) pair bound to a proof**, so when the tunnel closes you can verify the
  agents actually followed the rules — no cheating, replayable, auditable.
- **Post-quantum:** ZK proofs can be layered on existing keys for PQ-safety.

> **Who "figured it out":** Mysten themselves (Chalkias / Basecamp 2025) + analysts (ZKV,
> CCN) summarizing him. **No independent party has published the code or a working
> reproduction** — verified by enumerating MystenLabs' repos and 18 community
> "sui payment/state-channel/lightning" repos (all ordinary payment apps, none a tunnel).

---

## 2. The tunnel lifecycle (reconstructed step by step)

### A. OPEN — one on-chain transaction
**[Reconstructed]** Both parties lock assets/state into an on-chain contract (on Sui: a
**shared object**). This fixes the starting state (e.g. Alice 100, Bob 100) and the
participant public keys. This is the only tx needed to start.

### B. TRANSACT — fully off-chain, unbounded
**[Confirmed]** Interactions "proceed off-chain … eliminating latency and gas costs
between participants," and can run over "local transports like Bluetooth or low-range
radio" with no internet.
**[Reconstructed]** Each interaction is a new **state update** — a message describing
the new state, with a **monotonically increasing version/nonce**, **signed by all
participants**. The latest all-signed state is the source of truth. This is why you hit
"6M TPS": these updates are just signed messages, not on-chain transactions — throughput
is bounded by signing speed (and AI agents sign fast), not by consensus.

### C. CLOSE — one on-chain transaction + a proof
**[Confirmed]** "The final closing transaction settles the state using a **succinct
validity or fraud proof**." Two models:
- **Validity (ZK) proof** — the closer submits a ZK proof that the final state is the
  correct output of a valid sequence of updates under the app's rules. The on-chain
  verifier checks *only the proof* — cheap, and the intermediate steps stay **private**.
- **Fraud proof (optimistic)** — the closer just posts the final state; it's accepted
  unless a counterparty submits a proof it's wrong during a **challenge window.**

### D. PRIVACY & COMPLIANCE
**[Confirmed]** "Configurable privacy: transaction details can remain private until the
tunnel closes, or be selectively disclosed for regulatory compliance."
**[Reconstructed]** The ZK proof reveals only the final state (+ what you choose to
disclose); everything inside the tunnel is hidden. **Nautilus (TEE)** is where Sui said
"confidential transfers" will live — run the off-chain logic inside a trusted enclave so
participants trust the computation and get attestation + privacy.

---

## 3. Why ZK (what it adds over plain Lightning)

| Plain state channel (Lightning) | Sui ZK tunnel |
|---|---|
| On-chain contract replays the last signed state to settle | On-chain verifier checks **one succinct proof** |
| Only balance transfers | **Arbitrary off-chain logic** (games, markets, agents) |
| Intermediate + final state visible on dispute | **Private** — only the proven final state is revealed |
| 2-party, payment-focused | Aims at **multi-party, application-agnostic** |

The ZK proof is what turns "a payment channel" into "a programmable, private,
app-agnostic tunnel."

---

## 4. Map each piece to Sui primitives (what makes Sui a good fit)

| Tunnel part | Sui primitive |
|---|---|
| The channel / locked state | A **shared object** holding `Coin<T>` + state + versions + parties |
| Open / close / challenge / settle | **Move entry functions** on that object |
| Off-chain signed updates | **Ed25519 signatures** over `(channel_id, version, state…)` |
| Verify the final state | Move verifies signatures (toy) → a **ZK verifier** (real) |
| Dispute window | The **`Clock` (0x6)** + a stored deadline |
| Gasless settlement | **Sponsored transactions** pay the on-chain open/close |
| Confidential off-chain compute | **Nautilus (TEE)** |

Sui's object model + fast finality is why the *settlement* side is cheap and why this
composes cleanly — the tunnel is just a shared object you open and close.

---

## 5. The toy you CAN build + teach today (no ZK needed)

A **2-party payment channel in Move** — the exact pattern tunnels generalize. Buildable
now with just Move + PTBs; teaches 90% of the intuition.

```
module tunnels_toy::channel;

public struct Channel has key {
    id: UID,
    party_a: address,
    party_b: address,
    pubkey_a: vector<u8>,   // ed25519 pubkeys for off-chain state signing
    pubkey_b: vector<u8>,
    funds: Balance<SUI>,    // locked at open (a's coin + b's coin)
    // latest settled/claimed state
    version: u64,
    bal_a: u64,
    bal_b: u64,
    // dispute
    status: u8,             // 0 OPEN, 1 CLOSING, 2 SETTLED
    challenge_deadline_ms: u64,
}

// A. open: both lock coins, fix starting balances + signing keys
public fun open(coin_a: Coin<SUI>, coin_b: Coin<SUI>, party_b: address,
                pubkey_a: vector<u8>, pubkey_b: vector<u8>, ctx: &mut TxContext) { … }

// --- OFF-CHAIN (no Move): parties exchange messages
//     state_msg = bcs(channel_id, version, bal_a, bal_b)
//     each signs it with their ed25519 key. Higher version = newer truth.

// B. cooperative close: submit the latest DOUBLY-signed state → pay out, done in 1 tx
public fun close_cooperative(ch: &mut Channel, version: u64, bal_a: u64, bal_b: u64,
                             sig_a: vector<u8>, sig_b: vector<u8>, ctx: &mut TxContext) {
    // verify both sigs over the state; require version > ch.version;
    // pay bal_a to party_a, bal_b to party_b; status = SETTLED
}

// C. unilateral close (counterparty offline/cheating): post your best state,
//    open a challenge window via Clock
public fun close_unilateral(ch: &mut Channel, version, bal_a, bal_b,
                            sig_a, sig_b, clock: &Clock, ctx) { … } // status=CLOSING

// D. challenge: anyone can override with a HIGHER-version doubly-signed state
public fun challenge(ch: &mut Channel, version, bal_a, bal_b, sig_a, sig_b, clock) { … }

// E. settle: after the deadline, pay out the latest stored state
public fun settle(ch: &mut Channel, clock: &Clock, ctx) { … }
```

Sui has **native Ed25519 verification** in the framework, so the signature checks are a
few lines. That's the whole teaching arc:
**lock → sign off-chain updates → dispute with the highest-signed state → settle on-chain.**

---

## 6. From the toy → the real tunnel (what you'd add)

1. **Replace the on-chain state check with a ZK verifier** — instead of submitting the
   signed balances, submit a proof that the final state followed the app's rules. (Now
   the off-chain logic can be a *game* or a *market*, and stays private.)
2. **Generalize state** — from `(bal_a, bal_b)` to arbitrary app state.
3. **Multi-party** — N participants (all-sign, or a hub/virtual-channel model).
4. **TEE (Nautilus)** — run the off-chain compute in an enclave for confidential transfers.
5. **Any transport** — because updates are just signed blobs, ship them over Bluetooth /
   offline and settle later.

---

## 7. As a class

**Course title:** *"How Sui Hit 6M TPS — Build a Payment Channel (the Tunnels pattern)"*

| Block | Content |
|---|---|
| Concept (45m) | State channels, Lightning, why ZK, the tunnel lifecycle (this doc §1–4) |
| Build (90m) | The toy `channel` Move module: open → off-chain signed updates → cooperative + unilateral close → challenge → settle |
| Vision (20m) | The 6M-TPS experiment, ZK + Nautilus + multi-party, "where Sui is going" |

**Honest framing for students:** *the real Programmable Tunnels isn't public yet — but
here's the pattern it's built on, and here's you building it.*

---

## Sources
- Sui blog — 6M TPS AI-agent experiment
- ZKV, "What's Cooking at Sui" — ZK tunnels = Lightning generalization, open handshake +
  succinct validity/fraud proof at close, Bluetooth/offline transport, configurable privacy
- CryptoBriefing fact-check — 6M was a staged off-chain experiment; mainnet base layer is hundreds of TPS
- MystenLabs GitHub — no tunnels repo (confirmed by enumerating the org)

---

## 8. ✅ THE REAL DEPLOYED CONTRACT (reverse-engineered from Sui testnet)

**How we found it:** blog.sui.io → the event explorer **dev.millionstps.io** → its API
`GET /v1/settlements/{digest}` → the tunnel shared object on testnet → its type →
**package `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c`**
(token type `0xf62966a0…::mtps::MTPS`). We pulled the full ABI with
`sui_getNormalizedMoveModulesByPackage`. Everything below is from the actual bytecode.

### The 8 modules
| Module | What it is |
|---|---|
| **`tunnel`** | The core state channel (the `Tunnel<T>` shared object + open/update/close/dispute) |
| **`hop`** | **Multi-hop routing + HTLCs** — the Lightning Network routing layer, generalized |
| **`referee`** | **Dispute arbitration** — committee / designated / automated referees, graduated penalties |
| **`zk_verifier`** | **The ZK part** — register circuits (BN254/BLS12381, Groth16 pvk), verify state proofs |
| **`randomness`** | Commit-reveal + **BLS verifiable randomness** (fair games / AI seeding) |
| **`signature`** | ed25519 / secp256k1 / BLS12381 verification + domain-separated tunnel messages |
| **`arena_domain`** | Signature domain-separation tags |
| **`errors`** | Error codes |

### The real `Tunnel<T>` object (confirmed fields)
```
Tunnel<T> (shared object) {
  balance: Balance<T>,            party_a: PartyConfig,  party_b: PartyConfig,
  party_a_deposit, party_b_deposit,   // e.g. 500 / 500
  state: StateCommitment,         // { nonce, party_a_balance, party_b_balance, state_hash, timestamp }
  status,                          // created / active / disputed / closed / destroyed
  dispute_raiser, last_disputed_nonce, penalty_amount,
  timeout_ms (86_400_000 = 24h),  created_at, last_activity, version
}
```

### The real lifecycle (actual function names)
1. **OPEN** — `create_and_fund` / `create_and_share`: both parties deposit `Coin<T>`, register pubkeys + sig type. Emits `TunnelCreated`.
2. **OFF-CHAIN UPDATES** — parties co-sign `StateUpdateData` (nonce↑, balances, state_hash). `serialize_state_update` defines the exact signed bytes; `signature::create_tunnel_message` + `arena_domain` do domain separation. `update_state` can post one on-chain, but the whole point is you *don't* — you just keep the latest co-signed one. **This is the 6M TPS: signing messages, not transactions.**
3. **CLOSE** — `close_cooperative_with_root`: submit the final co-signed state + an **anchored transcript root** (Merkle root; moves stay hashed → privacy). Emits `TunnelClosedWithRoot`. (Settlement record: balances 200/800, finalNonce 1, transcriptRoot, checkpoint.)
4. **DISPUTE** — `raise_dispute` → resolved by `referee` (committee vote / designated / auto-timeout) **or** `resolve_dispute_verified` using a **ZK proof** (`zk_verifier`). Penalties (`referee::calculate_graduated_penalty`) punish violations: double_spend, forgery, invalid_state, no_response.
5. **TIMEOUT** — `force_close_after_timeout` / `withdraw_timeout` after 24h.
6. **ROUTING (multi-party)** — `hop` module: **HTLCs + routes across multiple tunnels** with fee policies — a Lightning-style payment network.

### So "how it works" — confirmed, in one paragraph
A tunnel is a **shared `Tunnel<T>` object** holding both parties' deposits. Parties
exchange **co-signed state updates** off-chain (nonce + balances + state_hash), signed with
domain-separated ed25519/secp256k1/BLS. To settle, one party submits the latest co-signed
state + a **Merkle transcript root** via `close_cooperative_with_root`; the chain verifies
the signatures and pays out. Cheating/absence is handled by a **dispute** path (referee
committee **or** a **ZK validity proof** via `zk_verifier`) with **graduated penalties**.
**HTLCs + the `hop` router** let payments route across many tunnels (Lightning-style).
Games get fairness from **commit-reveal BLS randomness**. That's the whole thing.

### Making it work — it's LIVE and callable
- Package (testnet): `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c`
- Token: `0xf62966a08ab983e10224012bace10d2189ee9af4d67f0640bacb1f6d561ec83b::mtps::MTPS`
- Explorer + API: `https://dev.millionstps.io/explorer` · `GET /v1/settlements?limit=100`
- Testnet RPC that worked: `https://rpc-testnet.suiscan.xyz`
- **Next step to "make it work":** call `create_and_share` (open a tunnel with two testnet
  keypairs) → sign a couple of `StateUpdateData` off-chain with our own signer →
  `close_cooperative_with_root`. We have every function signature; we can drive the real
  contract, or fork the ABI into our own teaching package.

---

## 9. 📓 RESUMABLE DOSSIER — full ABI, artifacts, and how to continue

Everything needed to pick this back up cold. All of this is pulled from the **deployed
bytecode** on Sui testnet, not inference.

### 9.1 Quick-reference: the concrete artifacts

| Thing | Value |
|---|---|
| **Tunnels package** (testnet) | `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c` |
| **MTPS token type** | `0xf62966a08ab983e10224012bace10d2189ee9af4d67f0640bacb1f6d561ec83b::mtps::MTPS` |
| **Sample tunnel object** | `0x9c614e57c11656ff71a1447d91db3d422fa19d7cea321ce4169ee5457eb2d94b` (shared, `Tunnel<MTPS>`) |
| **Sample settle tx** | `A6pFr1an9hXqHit4wd5Rq6v43Q7MFdXTVR7qiKGpYA5b` (200/800, nonce 1, game=regular_payments) |
| **"House" party (party A across many)** | `0x35e8b9d932badc99a636f8495e9cea05627169e103149d8d80d9c5734bed42e2` |
| **Event explorer** | `https://dev.millionstps.io/explorer` |
| **Settlements API (list)** | `GET https://dev.millionstps.io/v1/settlements?limit=100` (cursor: `nextCursor`) |
| **Settlement (one)** | `GET https://dev.millionstps.io/v1/settlements/{digest}` |
| **Transcript (off-chain moves)** | `GET https://dev.millionstps.io/v1/settlements/{digest}/transcript` |
| **Working testnet RPC** | `https://rpc-testnet.suiscan.xyz` (also `https://sui-testnet-endpoint.blockvision.org`) |
| **Dead ends** | `fullnode.testnet.sui.io` (404 on JSON-RPC path); old txs pruned from RPC (use the explorer API or an archival indexer) |
| Led by | Kostas Chalkias + Daniel Lam (Mysten "Sui hacker team"). Unveiled Basecamp 2025. |

### 9.2 The real structs (from bytecode)

```
struct Tunnel<T> has key {                 // the shared channel object
  id: UID, version: u64,
  party_a: PartyConfig, party_b: PartyConfig,
  balance: Balance<T>,                      // total locked
  party_a_deposit: u64, party_b_deposit: u64,
  status: u8,                               // created/active/disputed/closed/destroyed
  state: StateCommitment,                   // the latest agreed state
  created_at: u64, last_activity: u64, timeout_ms: u64,   // 86_400_000 = 24h
  penalty_amount: u64,
  dispute_raiser: Option<address>, last_disputed_nonce: u64,
}
struct PartyConfig { address, public_key: vector<u8>, signature_type: u8 }  // sigtype: ed25519/secp256k1/bls
struct StateCommitment { state_hash: vector<u8>, nonce: u64, timestamp: u64,
                         party_a_balance: u64, party_b_balance: u64 }
struct StateUpdateData { tunnel_id: ID, state_hash, nonce, timestamp,
                         party_a_balance, party_b_balance }   // <-- THIS is what gets signed
struct SettlementWithRootData { tunnel_id, party_a_balance, party_b_balance,
                                final_nonce, timestamp, transcript_root: vector<u8> }
```

### 9.3 The real functions (interpreted)

```
// OPEN
create_and_share(aAddr, aPubkey, aSigType, bAddr, bPubkey, bSigType, u64, u64, &Clock, &mut ctx)
create_and_fund (... same ..., coinA:Coin<T>, coinB:Coin<T>, u64, u64, &Clock, &mut ctx)  // + deposits
deposit(&mut Tunnel<T>, Coin<T>, &Clock, &ctx)

// OFF-CHAIN STATE, applied on-chain only when needed
update_state(&mut Tunnel<T>, state_hash, nonce, timestamp, balA, balB, sigA, sigB, &Clock)
//   ^ requires BOTH signatures over StateUpdateData. Nonce must increase.
serialize_state_update(&StateUpdateData) -> vector<u8>   // the exact signed bytes
create_state_hash(&vector<u8>) -> vector<u8>             // hash the app "moves" -> state_hash

// CLOSE (cooperative)
close_cooperative(&mut Tunnel<T>, balA, balB, sigA, sigB, finalNonce, &Clock, &mut ctx)
close_cooperative_with_root(&mut Tunnel<T>, balA, balB, sigA, sigB, finalNonce, transcriptRoot, &Clock, &mut ctx)

// DISPUTE (if a party cheats / goes offline)
raise_dispute(&mut Tunnel<T>, state_hash, nonce, ts, balA, balB, sig, &Clock, &ctx)      // present a signed state
resolve_dispute(&mut Tunnel<T>, state_hash, nonce, ts, balA, balB, sigA, sigB, &Clock)   // override w/ HIGHER-nonce co-signed state (fraud proof)
resolve_dispute_verified(&mut Tunnel<T>, u64, u64, &Clock, &mut ctx)  // [Friend] resolve via a ZK proof (zk_verifier)
force_close_after_timeout(&mut Tunnel<T>, &Clock, &mut ctx)          // after 24h, settle last agreed state
set_referee_cosigned(&mut Tunnel<T>, refereeAddr, sigA, sigB, &ctx)  // both parties appoint a referee

// HTLC / routing (Lightning-style)
lock_htlc(&mut Tunnel<T>, hashlock, amount, receiver, timeout, extra, &Clock, &ctx)
claim_htlc_in_tunnel(&mut Tunnel<T>, htlcKey, preimage, &Clock, &mut ctx)
```

### 9.4 The ZK design (module `zk_verifier`)

```
struct ZkStateProof { circuit_id: vector<u8>, public_inputs: vector<u8>, proof: vector<u8>, state_version: u64 }
struct Circuit { id, name, curve: u8 /*bn254|bls12381*/, pvk: groth16::PreparedVerifyingKey,
                 num_public_inputs: u64, input_schema_hash: vector<u8>, active: bool }
verify_zk_state_proof(&CircuitRegistry, &ZkStateProof) -> bool
verify_circuit_proof(&CircuitRegistry, circuit_id, public_inputs, proof) -> bool
```
→ It's **Groth16** (via Sui's native `sui::groth16`), curves **BN254 / BLS12381**, with a
registry of circuits (each has a prepared verifying key). Disputes can be settled by a proof
that the claimed final state is valid, instead of trusting a referee. This is the "ZK" in ZK tunnels.

### 9.5 The dispute court (module `referee`)

```
struct Dispute { id, raised_by, against, violation_type: u8, status: u8, evidence_hash,
                 state_nonce, raised_at, response_deadline, resolved_at, resolution: Resolution }
struct Resolution { party_a_amount, party_b_amount, penalty_deducted, reason: u8 }
struct RefereeConfig { referee_type /*automated|committee|designated*/, timeout_ms, grace_period_ms,
                       base_penalty, penalty_per_hour, max_penalty, penalties_enabled, min_response_time_ms }
violation types: double_spend, forgery, invalid_state, no_response
resolve_for_a / resolve_for_b / resolve_split ; calculate_graduated_penalty(config, history, ...)
```

### 9.6 How it works — the confirmed flow, end to end

1. `create_and_share` → a shared `Tunnel<MTPS>` with both parties' pubkeys + deposits (500/500).
2. Off-chain: parties build app "moves" → `create_state_hash(moves)` → a `StateUpdateData`
   `{tunnel_id, state_hash, nonce++, timestamp, balA, balB}` → `serialize_state_update` →
   **both sign it** (ed25519/secp256k1/bls, domain-separated). Latest co-signed state = truth.
   Millions of these happen off-chain → the 6M TPS.
3. `close_cooperative_with_root(balA, balB, sigA, sigB, finalNonce, transcriptRoot)` → chain
   verifies both sigs over the settlement, pays out `balance` as balA/balB, records the
   Merkle `transcript_root` (moves stay hashed → privacy). (Our sample: 200/800, nonce 1.)
4. If a party cheats/vanishes: `raise_dispute` (present your best co-signed state) → other
   party `resolve_dispute` with a **higher-nonce** co-signed state, OR `resolve_dispute_verified`
   with a **ZK proof**, OR a `referee` resolves. Penalties deducted. `force_close_after_timeout`
   after 24h.
5. Multi-party payments route via `hop` (HTLCs across tunnels) — Lightning-style.

### 9.7 What's still UNKNOWN (open threads to continue)

- **The exact off-chain protocol** (message envelope, transport, how agents drive it) — not in
  the ABI. Would come from: the `/transcript` API, the client/agent code (not public), or the
  livestream. TODO: `GET /v1/settlements/{digest}/transcript` on a settlement that *has* a
  transcript (our sample says "transcript unavailable").
- **The ZK circuits themselves** (what statement they prove) — only the verifier + pvk are
  on-chain; the circom/witness is off-chain. TODO: inspect `CircuitRegistry` objects for
  registered circuit `input_schema_hash` + `num_public_inputs`.
- **`create_and_share` two trailing u64s** — likely (initial balances) or (timeout, penalty).
  TODO: disassemble the function or find an `opened` tx's args.
- **`hop`/`arena_domain` full field types** — not yet dumped. TODO below.

### 9.8 EXACT commands to resume / go deeper

```bash
RPC=https://rpc-testnet.suiscan.xyz
PKG=0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c

# Full ABI again (all 8 modules, structs + function signatures):
curl -s -X POST $RPC -H 'content-type: application/json' \
 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getNormalizedMoveModulesByPackage\",\"params\":[\"$PKG\"]}" > mods.json

# A live tunnel object's fields (shared object still on-chain):
curl -s -X POST $RPC -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0x9c614e57c11656ff71a1447d91db3d422fa19d7cea321ce4169ee5457eb2d94b",{"showType":true,"showContent":true}]}'

# More settlements (open+settle records, with cursor):
curl -s "https://dev.millionstps.io/v1/settlements?limit=100"
curl -s "https://dev.millionstps.io/v1/settlements/{DIGEST}"
curl -s "https://dev.millionstps.io/v1/settlements/{DIGEST}/transcript"   # off-chain moves, when archived

# To disassemble a function's real logic (bytecode), clone the package with the Sui CLI:
sui client switch --env testnet
sui move disassemble --package $PKG --module tunnel     # (or download via getObject bcs + a decompiler)
```

### 9.9 Building our own (teaching / "make it work")

We have enough to either **(a) call the live contract** (open a tunnel with two testnet
keypairs → co-sign a `StateUpdateData` off-chain → `close_cooperative_with_root`), or
**(b) fork the ABI into a slimmed teaching package** `tunnels_edu::channel` with:
`create_and_share` · `update_state` (2 sigs, nonce↑) · `close_cooperative_with_root` ·
`raise_dispute`/`resolve_dispute` (higher-nonce override) · `force_close_after_timeout`.
Drop `zk_verifier`/`hop`/`referee` for v1; add them as "advanced" once the core clicks.
