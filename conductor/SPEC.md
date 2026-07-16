# Sui Programmable Tunnels — signing spec (reverse-engineered from bytecode)

Package (testnet): `0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c`
Reconstructed from the deployed Move bytecode (`sui move disassemble`). No SDK/source exists.

## signature_type constants (`signature` module)

| type | value | pubkey | signature |
|---|---|---|---|
| ed25519      | 0 | 32 | 64 |
| bls12381_min_sig | 1 | 96 | 48 |
| bls12381_min_pk  | 2 | 48 | 96 |
| secp256k1    | 3 | 33 | 64 |

`verify(sig_type, public_key, message, signature)` dispatches to the Sui natives
(`ed25519_verify`, `bls12381_min_pk_verify`/`min_sig`, `secp256k1_verify` with sha256).
**The message is passed RAW** — the natives hash internally. Do NOT pre-hash.

## Cooperative-close preimage (86 bytes, raw concat)

```
msg = "sui_tunnel::settlement"        (22 ASCII bytes, raw, no length prefix)
    || tunnel_id                       (32)
    || u64_be(party_a_balance)         (8)
    || u64_be(party_b_balance)         (8)
    || u64_be(final_nonce)             (8)   <-- = on-chain state.nonce + 1 (DERIVED, not passed)
    || u64_be(timestamp)               (8)   <-- created_at <= ts <= clock.now_ms
```

Both parties sign this identical preimage. Gotcha: `final_nonce` is computed on-chain
(`state.nonce + 1`); read the current nonce from the object or signatures won't verify.

## State-update preimage (different!) — `sui_tunnel::state_update`

```
msg = "sui_tunnel::state_update" || tunnel_id(32) || state_hash(32)
    || u64_be(nonce) || u64_be(timestamp) || u64_be(balA) || u64_be(balB)
```
Here nonce + timestamp are caller-supplied. `close_cooperative_with_root` = settlement
with domain `sui_tunnel::settlement_v2` + a trailing raw `transcript_root`.

## BLS group party (min_pk)

- pubkey = `aggregatePublicKeys([...member G1 pubkeys])` → 48 bytes, `signature_type = 2`.
- signature = `aggregateSignatures([ member.sign(hash_to_G2(msg)) ... ])` → 96 bytes.
- **DST must match Sui:** `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_`.
- Members sign the *same* `msg`; aggregate verifies against the aggregate pubkey with the
  contract's single-sig `bls12381_min_pk_verify`.

## Deployed modules

`tunnel` (channel), `hop` (HTLC multi-hop routing), `referee` (dispute court + graduated
penalties), `zk_verifier` (Groth16 BN254/BLS12381), `randomness` (BLS VRF), `signature`,
`arena_domain`, `errors`.

## Open gotcha

`entry_create_and_share(aAddr, aPub, aSigType, bAddr, bPub, bSigType, dep_a, dep_b, clock)`
— `dep_a` (and the cap check) require **`dep_a > 0`** and `dep_a <= CAP`. Unfunded opens
still declare non-zero deposits; the actual `Balance<T>` is 0, and close asserts
`balA + balB == balance` (so an unfunded tunnel closes 0/0).
