# tunnel-conductor — a GROUP as a party on Sui Programmable Tunnels

**Result: a group can be a party in a Sui "Programmable Tunnel" — proven against the
LIVE 6M-TPS contract on testnet, with zero changes to the deployed contract.**

Sui's Programmable Tunnels (the July-4-2026 "6M TPS" experiment) are Lightning-style
off-chain state channels: two parties co-sign state updates off-chain, and settle the
final co-signed state on-chain. A tunnel is **hard-wired to exactly 2 parties**
(`party_a`, `party_b`) — Mysten lists "tunnels supporting more than two participants"
as *future* work.

This PoC shows the cheapest way to a multi-party tunnel: make **one party a group**.
Because each `PartyConfig` carries a `signature_type` and the contract natively verifies
**ed25519 / secp256k1 / BLS12381**, a group of N members can use a **BLS aggregate**
public key as `party_b`. All members co-sign the *same* settlement message; their
aggregate is a single valid signature the contract accepts — so a group settles a tunnel
exactly like a single party, **no contract fork**.

## Proof (live testnet)

Contract: `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c` (testnet)

| experiment | party_a | party_b | close result | tx |
|---|---|---|---|---|
| EXP1 | ed25519 | ed25519 | ✅ verified | `HncvSvET5rFswRyT7VMV2k4TPzQJv4rDGu3Si9n1C2zN` |
| EXP2 | ed25519 | **BLS aggregate group of 3** | ✅ verified | `8iMsAfMtuLim5mewTLQ4JLojHpT6f4wJqFuXhFUe5LEW` |

EXP1 validates the reverse-engineered signing format; EXP2 is the headline — a 3-member
BLS-aggregate `party_b` settling a real tunnel.

## How it works

1. **Open** `entry_create_and_share` (unfunded — no MTPS needed): register `party_a`
   (ed25519) and `party_b` (the group's **aggregate BLS pubkey**, `signature_type = 2`
   = bls_min_pk).
2. **Off-chain co-sign** the 86-byte settlement preimage (see [`SPEC.md`](./SPEC.md)).
   party_a signs with ed25519; the **3 group members each sign the same message** and the
   signatures are **aggregated** into one 96-byte BLS signature.
3. **Close** `entry_close_cooperative` — the contract rebuilds the preimage and verifies
   party_a's ed25519 sig and party_b's aggregate BLS sig with its native verifiers.
   Both pass → settled.

Same-message BLS aggregation means `agg_sig = (Σ sk_i)·H(m)` verifies against
`agg_pk = Σ pk_i·G` under the contract's ordinary single-sig pairing check — so a group
"is" one BLS party.

## Run

```sh
bun install
ACTIVE_ADDR=$(sui client active-address) bun run harness.ts   # testnet, funded wallet
```

## Notes / honesty

- **Unfunded tunnels** (balance 0, close 0/0) are used to isolate the *signature*
  verification path; funding is orthogonal (use `create_and_fund` + a real balance split).
- **Rogue-key caveat:** naive same-message aggregation is vulnerable to rogue-public-key
  attacks. This PoC proves acceptance; a production group party needs proof-of-possession
  (each member proves knowledge of their key) or an Ika dWallet as the group signer.
- **Multi-hop / conductor:** the deployed contract already ships a `hop` module (HTLCs +
  routing across tunnels) — the Lightning routing layer. A "tunnel conductor" for dynamic
  groups is a `hop` router over these BLS/Ika group tunnels.
