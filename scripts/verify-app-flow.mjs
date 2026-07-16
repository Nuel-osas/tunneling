// Verifies the Tunnel Playground app flow end-to-end by playing the browser's
// role against the RUNNING dev server (or a deployed URL): calls its /api/fund
// endpoint, then executes exactly the calls App.tsx makes — create, deposit ×2,
// co-signed off-chain updates ×3, cooperative settle.
//
//   APP_URL=http://localhost:5175 node scripts/verify-app-flow.mjs

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "deployed.json"), "utf8"));
const APP = process.env.APP_URL ?? "http://localhost:5175";
const client = new SuiClient({ url: cfg.rpc });
const PKG = cfg.packageId;
const CLOCK = "0x6";
const DEPOSIT = 50_000_000n;
const STEP = 5_000_000n;
const link = (d) => `https://suiscan.xyz/testnet/tx/${d}`;

const StateUpdateData = bcs.struct("StateUpdateData", {
  tunnel_id: bcs.Address, state_hash: bcs.vector(bcs.u8()), nonce: bcs.u64(),
  timestamp: bcs.u64(), party_a_balance: bcs.u64(), party_b_balance: bcs.u64(),
});

async function exec(signer, tx, label) {
  tx.setGasBudget(30_000_000n);
  const res = await client.signAndExecuteTransaction({ signer, transaction: tx, options: { showEffects: true, showObjectChanges: true } });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects.status.status !== "success") throw new Error(`${label}: ${JSON.stringify(res.effects.status)}`);
  console.log(`  [tx] ${label}: ${link(res.digest)}`);
  return res;
}

const alice = Ed25519Keypair.generate();
const bob = Ed25519Keypair.generate();
const A = alice.toSuiAddress(), B = bob.toSuiAddress();
console.log("Alice:", A, "\nBob:  ", B);

// 1) the app's fund endpoint
console.log("\n[1] POST /api/fund (the app's funder endpoint)");
const fr = await fetch(`${APP}/api/fund`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ addresses: [A, B] }),
});
if (!fr.ok) throw new Error(`/api/fund ${fr.status}: ${await fr.text()}`);
console.log("  funded:", (await fr.json()).digest);
// wait for the coin index to catch up (same guard the app uses)
for (let i = 0; i < 20; i++) {
  const [ba, bb] = await Promise.all([
    client.getBalance({ owner: A }), client.getBalance({ owner: B }),
  ]);
  if (BigInt(ba.totalBalance) > 0n && BigInt(bb.totalBalance) > 0n) break;
  await new Promise((r) => setTimeout(r, 1000));
}

// 2) open: create + two deposits (exactly App.tsx's doOpen)
console.log("\n[2] Open tunnel (create + 2 deposits)");
const ct = new Transaction();
ct.moveCall({
  target: `${PKG}::channel::create_and_share`,
  arguments: [
    ct.pure.address(A), ct.pure.vector("u8", Array.from(alice.getPublicKey().toRawBytes())),
    ct.pure.address(B), ct.pure.vector("u8", Array.from(bob.getPublicKey().toRawBytes())),
    ct.pure.u64(30_000n), ct.object(CLOCK),
  ],
});
const cres = await exec(alice, ct, "create tunnel");
const tunnelId = cres.objectChanges.find((o) => o.objectType === `${PKG}::channel::Tunnel`).objectId;

for (const [who, name] of [[alice, "Alice"], [bob, "Bob"]]) {
  const dt = new Transaction();
  const [c] = dt.splitCoins(dt.gas, [dt.pure.u64(DEPOSIT)]);
  dt.moveCall({ target: `${PKG}::channel::deposit`, arguments: [dt.object(tunnelId), c, dt.object(CLOCK)] });
  await exec(who, dt, `${name} deposits 0.05`);
}

// 3) three co-signed OFF-CHAIN updates (exactly App.tsx's pay())
console.log("\n[3] Three co-signed off-chain updates (no transactions)");
let a = DEPOSIT, b = DEPOSIT, last = null;
for (let n = 1; n <= 3; n++) {
  a += STEP; b -= STEP;
  const ts = Date.now();
  const hash = new TextEncoder().encode(`update-${n}`.padEnd(32, "0")).slice(0, 32);
  const msg = StateUpdateData.serialize({
    tunnel_id: tunnelId, state_hash: Array.from(hash), nonce: BigInt(n),
    timestamp: BigInt(ts), party_a_balance: a, party_b_balance: b,
  }).toBytes();
  last = { n, ts, a, b, hash, sigA: await alice.sign(msg), sigB: await bob.sign(msg) };
  console.log(`  update #${n} co-signed: A ${(Number(a)/1e9).toFixed(3)} · B ${(Number(b)/1e9).toFixed(3)}  (off-chain)`);
}

// 4) settle at the latest (exactly App.tsx's doSettle)
console.log("\n[4] Settle at nonce", last.n);
const st = new Transaction();
st.moveCall({
  target: `${PKG}::channel::close_cooperative`,
  arguments: [
    st.object(tunnelId),
    st.pure.u64(last.a), st.pure.u64(last.b), st.pure.u64(BigInt(last.n)),
    st.pure.vector("u8", Array.from(last.hash)), st.pure.u64(BigInt(last.ts)),
    st.pure.vector("u8", Array.from(last.sigA)), st.pure.vector("u8", Array.from(last.sigB)),
    st.object(CLOCK),
  ],
});
await exec(alice, st, "settle (cooperative close)");

const o = await client.getObject({ id: tunnelId, options: { showContent: true } });
const f = o.data.content.fields;
const closed = JSON.stringify(f.status).includes("Closed");
console.log(`\n  on-chain final: nonce ${f.state.fields.nonce}, A ${(Number(f.state.fields.party_a_balance)/1e9).toFixed(3)}, B ${(Number(f.state.fields.party_b_balance)/1e9).toFixed(3)}, closed=${closed}`);
if (!closed || Number(f.state.fields.nonce) !== last.n) throw new Error("FAIL: settle mismatch");

console.log("\n✅ Playground flow verified: fund endpoint + open + 3 off-chain co-signed updates + settle.");
console.log("   4 on-chain txs total; the 3 updates never touched the chain.");
