# Tunnels FAQ — the questions everyone asks

Real questions from teaching this material, with the precise answers.

---

### 1. Who creates the tunnel — Alice and Bob together?

**One transaction, one sender.** `create_and_share` just *declares* the channel (both
parties' addresses + signing keys + timeout) — it moves nobody's money, so it needs
nobody's consent. Anyone can send it: Alice, Bob, or a third party (a matchmaking
service). **Consent is expressed by funding:** the tunnel only flips to `Active` when
*both* sides have deposited. Bob's deposit *is* his "yes." Prerequisite: the parties
exchange public keys off-chain first — that's the real handshake.
*(The production contract adds `create_and_fund` — create + deposits in one tx — and
`withdraw_before_active` so a deposit can be pulled back if the other side ghosts.)*

### 2. Where are the off-chain updates stored?

**Nowhere global.** No mempool, no server of record, nothing on-chain. Each party
stores their own copy of the co-signed states on their own device. The **newest
co-signed state is your money claim** — a bearer instrument; guard it like a key. You
only need the latest one (highest nonce beats everything). Production apps persist
every state to disk/DB and send a copy to a **watchtower** so disputes can be defended
while you're offline. The playground keeps them in browser memory — fine for a demo,
wrong for production.

### 3. Do I need to write a Move contract to use this?

**Usually no.** The channel contract is generic — payments, chat, streaming, and a
game all ran through `tunnels_edu::channel` *unchanged*. Reuse it, or `sui client
publish` your own copy (publishing isn't writing). You write new Move only when the
chain must judge **what happened**, not just **how much moved**:

| Your case | New Move? |
|---|---|
| Moving SUI (pay / chat / stream / tips) | **No** — reuse as-is |
| A different token | ~5-line edit: `Balance<SUI>` → `Balance<T>` |
| A game verdict ("did I win?") | Yes — referee (v1) → deterministic replay (v2) → ZK (v3) |
| Multi-hop / penalties / multi-party | Yes — crib from the real contract's `hop` + `referee` |

### 4. Must both parties deposit money?

**You lock only what you might owe.** Deposits are *collateral for the promises you
make in the channel*, not spending. If value flows one direction only (pure
pay-to-play), only the payer deposits. In a game with prizes, the house deposits a
prize float *because it might pay you*. Unused deposit comes back at settlement — it's
escrow, not a fee. Zero locked = nothing enforceable = not really a channel.

### 5. Can a tunnel have just one person?

**No — a tunnel is a relationship, not an account.** Co-signing, disputes, and the
whole design assume a counterparty. "Single-player" really means **you ↔ the house**
(the game/service is the second party). Scaling goes the other way: *more* than two
parties via multisig or Ika MPC dWallets.

### 6. If a message/payment isn't on-chain, how does the other party receive it?

Over an ordinary **live connection** — the chain is only the vault and the courtroom.
Player ↔ house rides the game's own WebSocket; p2p uses WebRTC; mobile apps use a
**relay**. The relay is untrusted plumbing: it can drop or delay messages but can't
forge a state, because every state carries both signatures.

### 7. So both parties must be online?

**Yes — tunnels are synchronous.** Advancing state needs a fresh signature from each
side, so a tunnel is a *live session*, not a mailbox. (On-chain transfers are the
asynchronous option — the recipient can be asleep.) This is the genuine trade-off you
pay for the speed.

### 8. What if the connection drops — or I lose my saved states?

A dropped connection hurts **liveness, never safety**: you can't make new states, but
the last co-signed state is still enforceable — reconnect, or `force_close` at it.
Losing your *stored states* is worse: you're trusting your counterparty's copy (hence
persistence + watchtowers). The production contract adds `raise_dispute_current_state`
so even with everything lost you can exit at the last on-chain-known state.

### 9. What does "6M TPS" actually measure?

**Off-chain co-signed state updates per second — signing throughput — not base-layer
transactions.** Both numbers are real; they measure different things. Accurate
sentence: "tunnels exchanged ~6M signed updates per second off-chain, settling and
disputing on Sui."

### 10. Why is posting an old, favorable state pointless?

Every state is co-signed and carries a strictly-increasing **nonce**. A dispute can
always be answered with a **higher-nonce** co-signed state before the timeout, and
`force_close` settles at the highest nonce seen. The cheater's only hope is that the
honest party is offline for the *entire* dispute window — which is what watchtowers
eliminate. Plus balance conservation: you can't sign money into existence.

---

*More depth: [`tunnels-explained.md`](./tunnels-explained.md) (the mechanism, end to
end) · [`reverse-engineering.md`](./reverse-engineering.md) (how the real contract was
recovered) · the live demo: **tunnel-playground.vercel.app***
