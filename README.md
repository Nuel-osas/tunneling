# Programmable Tunnels on Sui — Day 3

Reverse-engineer the state-channel pattern behind Sui's **6M TPS** experiment, and
build a **faithful, working mini-version** — verified end to end on testnet.

**The honest framing:** Programmable Tunnels has **no public SDK or docs**. But the
6M-TPS experiment *settled on-chain*, so the real contract is public. We dissect it
straight off testnet, then reproduce the core pattern ourselves.

## The idea in one line

Two parties open a funded channel on-chain, then transact by exchanging **co-signed
balance updates off-chain** — each is a `{ nonce, balances, state_hash }` both
parties sign. Throughput is bounded by **how fast they can sign**, not by consensus.
The chain is touched only to **open** and **settle**. The monotonic `nonce` makes
cheating pointless: any stale state is beaten by a newer co-signed one.

## What's here

| Path | What it is |
|---|---|
| `move/sources/channel.move` | **`tunnels_edu::channel`** — a faithful slimmed tunnel: shared `Tunnel`, two parties (ed25519 keys), pooled balance, co-signed `update`/`close_cooperative`, and a dispute court (`raise_dispute` → `resolve_dispute` → `force_close`). |
| `move/tests/` | `sui move test` — state-machine coverage (open/fund/activate, guards, dispute timing, settlement). |
| `scripts/tunnel-e2e.mjs` | Real end-to-end on testnet: open → 5 off-chain co-signed updates → cooperative settle, **and** a dispute where a stale state is overridden. |
| `docs/tunnels-explained.md` | Teaching reference — the real contract + our mini-version. |
| `docs/real-tunnel-abi.json` | The actual deployed contract's `tunnel` module ABI, pulled off testnet. |

## The real contract (reverse-engineered)

Live on **testnet** (not mainnet — it was an experiment):
`0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c` — 8 modules:
`tunnel`, `hop`, `referee`, `zk_verifier`, `signature`, `randomness`, `arena_domain`,
`errors`. Our teaching package mirrors the `tunnel` core (co-signed `StateCommitment`,
monotonic nonce, cooperative close, dispute-by-higher-nonce + timeout).

## Run

```bash
pnpm install
cd move && sui move test          # state-machine tests
cd .. && SPONSOR_KEY=suiprivkey1... pnpm e2e   # real tunnel on testnet
```

`SPONSOR_KEY` is any funded testnet key (funds Alice/Bob's gas + deposits):
`sui keytool export --key-identity <addr> --json`.

## Verified on testnet

- teaching package: `0x9bd35322a0e12f0339f7af281838e0ae40ce15238c3a75b55cae8e421afc1c4e`
- cooperative settle: `5adsxYTz6Vviqvvk5DdnooYvsXALrmw8wU9PyCHktdpS`
- dispute force-close: `813E5uFQJEcrV5fZ8c1Bbw2Wrxst2xf63sK1AauV858u`

> Testnet resets periodically — if IDs stop resolving, republish `move/` and repaste.
> Public testnet fullnode 404s for JSON-RPC → we pin `https://sui-testnet-rpc.publicnode.com`.

## Stack

Sui Move 2024 · `@mysten/sui` (ed25519 co-signing, BCS state messages) · Node 20.

---
SuiHub Lagos · Sui Stack 2026 · Day 3.
