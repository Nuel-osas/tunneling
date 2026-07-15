// Programmable Tunnel — REAL end to end, on Sui testnet.
//
// Proves the state-channel pattern the 6M TPS claim rests on:
//   1. Alice + Bob open a funded, shared Tunnel (one on-chain tx).
//   2. They exchange many CO-SIGNED balance updates OFF-CHAIN — the chain is not
//      touched. Throughput here is bounded only by how fast they sign.
//   3a. Cooperative close: settle at the latest co-signed state (one on-chain tx).
//   3b. Dispute: a party posts a STALE state; the counterparty overrides it with a
//       higher-nonce co-signed state; after the timeout it settles at the newest.
//
// Only input: SPONSOR_KEY (a funded testnet key, bech32) to fund Alice/Bob's gas.
//   SPONSOR_KEY=suiprivkey1... node scripts/tunnel-e2e.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "deployed.json"), "utf8"));
const client = new SuiClient({ url: cfg.rpc });
const PKG = cfg.packageId;
const CLOCK = "0x6";
const T = `${PKG}::channel::Tunnel`;
const link = (d) => `https://suiscan.xyz/testnet/tx/${d}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The exact struct both parties sign — must match Move's StateUpdateData / bcs::to_bytes.
const StateUpdateData = bcs.struct("StateUpdateData", {
  tunnel_id: bcs.Address,
  state_hash: bcs.vector(bcs.u8()),
  nonce: bcs.u64(),
  timestamp: bcs.u64(),
  party_a_balance: bcs.u64(),
  party_b_balance: bcs.u64(),
});

function loadFunder() {
  const key = process.env.SPONSOR_KEY;
  if (!key) throw new Error("set SPONSOR_KEY=suiprivkey1... (a funded testnet key)");
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(key.trim()).secretKey);
}
const pubRaw = (kp) => Array.from(kp.getPublicKey().toRawBytes()); // 32-byte ed25519 key

async function exec(signer, tx, label) {
  tx.setGasBudget(50_000_000n);
  const res = await client.signAndExecuteTransaction({
    signer, transaction: tx, options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects.status.status !== "success") throw new Error(`${label} failed: ${JSON.stringify(res.effects.status)}`);
  return res;
}

async function fund(funder, addr, mist) {
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(mist)]);
  tx.transferObjects([c], tx.pure.address(addr));
  await exec(funder, tx, "fund");
}

// A co-signed off-chain state update. Nothing on-chain happens here.
async function coSign(alice, bob, tunnelId, { nonce, ts, a, b, hash }) {
  const msg = StateUpdateData.serialize({
    tunnel_id: tunnelId, state_hash: Array.from(hash), nonce, timestamp: ts, party_a_balance: a, party_b_balance: b,
  }).toBytes();
  const sigA = await alice.sign(msg);
  const sigB = await bob.sign(msg);
  return { nonce, ts, a, b, hash, sigA, sigB };
}

async function openTunnel(funder, alice, bob, depA, depB, timeoutMs) {
  // create
  const create = new Transaction();
  create.moveCall({
    target: `${PKG}::channel::create_and_share`,
    arguments: [
      create.pure.address(alice.toSuiAddress()), create.pure.vector("u8", pubRaw(alice)),
      create.pure.address(bob.toSuiAddress()), create.pure.vector("u8", pubRaw(bob)),
      create.pure.u64(timeoutMs), create.object(CLOCK),
    ],
  });
  const res = await exec(alice, create, "create_and_share");
  const tunnelId = res.objectChanges.find((o) => o.objectType === T).objectId;

  const dep = async (who, amt) => {
    const tx = new Transaction();
    const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(amt)]);
    tx.moveCall({ target: `${PKG}::channel::deposit`, arguments: [tx.object(tunnelId), c, tx.object(CLOCK)] });
    await exec(who, tx, "deposit");
  };
  await dep(alice, depA);
  await dep(bob, depB);
  return tunnelId;
}

async function readTunnel(id) {
  const o = await client.getObject({ id, options: { showContent: true } });
  const f = o.data.content.fields;
  return {
    nonce: Number(f.state.fields.nonce),
    a: Number(f.state.fields.party_a_balance),
    b: Number(f.state.fields.party_b_balance),
    closed: JSON.stringify(f.status).includes("Closed"),
  };
}

const H = (s) => new TextEncoder().encode(s.padEnd(32, "0")).slice(0, 32);

async function main() {
  const funder = loadFunder();
  const alice = Ed25519Keypair.generate();
  const bob = Ed25519Keypair.generate();
  console.log("Alice:", alice.toSuiAddress());
  console.log("Bob:  ", bob.toSuiAddress());

  console.log("\nFunding Alice & Bob for gas + deposits…");
  await fund(funder, alice.toSuiAddress(), 300_000_000n);
  await fund(funder, bob.toSuiAddress(), 300_000_000n);

  // ---- Scenario 1: cooperative close ----------------------------------------
  console.log("\n=== Scenario 1 — cooperative close ===");
  const depA = 60_000_000, depB = 40_000_000; // 0.06 / 0.04 SUI
  const t1 = await openTunnel(funder, alice, bob, depA, depB, 5000);
  console.log("[open] tunnel", t1, "— Alice 0.06 + Bob 0.04, active");

  // exchange 5 co-signed updates OFF-CHAIN — Alice slowly earns from Bob
  const ts0 = Date.now();
  let last;
  for (let n = 1; n <= 5; n++) {
    const a = depA + n * 2_000_000, b = depB - n * 2_000_000; // shift 0.002 SUI per update
    last = await coSign(alice, bob, t1, { nonce: n, ts: ts0 + n, a, b, hash: H(`update-${n}`) });
    console.log(`  off-chain update #${n}: Alice ${(a / 1e9).toFixed(3)}  Bob ${(b / 1e9).toFixed(3)}  (co-signed, not on-chain)`);
  }

  // settle at the latest co-signed state — one on-chain tx
  const close = new Transaction();
  close.moveCall({
    target: `${PKG}::channel::close_cooperative`,
    arguments: [
      close.object(t1), close.pure.u64(last.a), close.pure.u64(last.b), close.pure.u64(last.nonce),
      close.pure.vector("u8", Array.from(last.hash)), close.pure.u64(last.ts),
      close.pure.vector("u8", Array.from(last.sigA)), close.pure.vector("u8", Array.from(last.sigB)),
      close.object(CLOCK),
    ],
  });
  const c1 = await exec(alice, close, "close_cooperative");
  const s1 = await readTunnel(t1);
  console.log(`[settle] ${link(c1.digest)}`);
  console.log(`  final on-chain: Alice ${(s1.a / 1e9).toFixed(3)}  Bob ${(s1.b / 1e9).toFixed(3)}  nonce ${s1.nonce}  closed=${s1.closed}`);
  if (s1.a !== last.a || s1.b !== last.b) throw new Error("FAIL: settled balances != final co-signed state");
  console.log("  ✅ 5 updates happened off-chain; only open + settle touched the chain.");

  // ---- Scenario 2: dispute (stale state gets overridden) ---------------------
  console.log("\n=== Scenario 2 — dispute: a stale state is beaten by a higher nonce ===");
  const t2 = await openTunnel(funder, alice, bob, depA, depB, 20000); // 20s dispute window (room for the on-chain round-trips)
  console.log("[open] tunnel", t2);

  // both sign an early state (nonce 2) AND a later state (nonce 4)
  const early = await coSign(alice, bob, t2, { nonce: 2, ts: Date.now(), a: depA + 2_000_000, b: depB - 2_000_000, hash: H("early") });
  const later = await coSign(alice, bob, t2, { nonce: 4, ts: Date.now() + 1, a: depA + 8_000_000, b: depB - 8_000_000, hash: H("later") });

  // Bob cheats: posts the EARLY state (more favorable to him)
  const rd = new Transaction();
  rd.moveCall({
    target: `${PKG}::channel::raise_dispute`,
    arguments: [
      rd.object(t2), rd.pure.u64(early.a), rd.pure.u64(early.b), rd.pure.u64(early.nonce),
      rd.pure.vector("u8", Array.from(early.hash)), rd.pure.u64(early.ts),
      rd.pure.vector("u8", Array.from(early.sigA)), rd.pure.vector("u8", Array.from(early.sigB)), rd.object(CLOCK),
    ],
  });
  await exec(bob, rd, "raise_dispute");
  console.log(`  Bob posted the STALE state (nonce 2): Alice ${(early.a / 1e9).toFixed(3)} Bob ${(early.b / 1e9).toFixed(3)}`);

  // Alice overrides with the higher-nonce co-signed state
  const res = new Transaction();
  res.moveCall({
    target: `${PKG}::channel::resolve_dispute`,
    arguments: [
      res.object(t2), res.pure.u64(later.a), res.pure.u64(later.b), res.pure.u64(later.nonce),
      res.pure.vector("u8", Array.from(later.hash)), res.pure.u64(later.ts),
      res.pure.vector("u8", Array.from(later.sigA)), res.pure.vector("u8", Array.from(later.sigB)), res.object(CLOCK),
    ],
  });
  await exec(alice, res, "resolve_dispute");
  console.log(`  Alice overrode it with the NEWER state (nonce 4): Alice ${(later.a / 1e9).toFixed(3)} Bob ${(later.b / 1e9).toFixed(3)}`);

  console.log("  waiting out the dispute window…");
  await sleep(22000);

  const fc = new Transaction();
  fc.moveCall({ target: `${PKG}::channel::force_close`, arguments: [fc.object(t2), fc.object(CLOCK)] });
  const c2 = await exec(alice, fc, "force_close");
  const s2 = await readTunnel(t2);
  console.log(`[force_close] ${link(c2.digest)}`);
  console.log(`  settled at nonce ${s2.nonce}: Alice ${(s2.a / 1e9).toFixed(3)}  Bob ${(s2.b / 1e9).toFixed(3)}`);
  if (s2.nonce !== later.nonce) throw new Error("FAIL: dispute did not settle at the highest nonce");
  console.log("  ✅ The stale state lost — the highest-nonce co-signed state won.");

  console.log("\n✅ Programmable tunnel proven end to end: off-chain co-signed updates,");
  console.log("   cooperative settlement, and a dispute where the newest state wins.");
}

main().catch((e) => { console.error("\nE2E FAILED:", e.message); process.exit(1); });
