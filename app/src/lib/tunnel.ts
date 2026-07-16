// Browser port of the verified tunnel e2e (scripts/tunnel-e2e.mjs).
// Same BCS state message, same ed25519 co-signing, same on-chain calls —
// just driven from a UI instead of a script.

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { CONFIG } from "../config";

export const client = new SuiClient({ url: CONFIG.rpc });

// Must match Move's StateUpdateData / bcs::to_bytes exactly.
const StateUpdateData = bcs.struct("StateUpdateData", {
  tunnel_id: bcs.Address,
  state_hash: bcs.vector(bcs.u8()),
  nonce: bcs.u64(),
  timestamp: bcs.u64(),
  party_a_balance: bcs.u64(),
  party_b_balance: bcs.u64(),
});

export interface SignedState {
  nonce: number;
  ts: number;
  a: bigint; // Alice balance (MIST)
  b: bigint; // Bob balance (MIST)
  hash: Uint8Array;
  sigA: Uint8Array;
  sigB: Uint8Array;
}

export interface ChainTx {
  label: string;
  digest: string;
  objectChanges?: any[];
}

const pubRaw = (kp: Ed25519Keypair) => Array.from(kp.getPublicKey().toRawBytes());

async function exec(signer: Ed25519Keypair, tx: Transaction, label: string): Promise<ChainTx> {
  tx.setGasBudget(30_000_000n);
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const status = (res.effects as any)?.status?.status;
  if (status !== "success") {
    throw new Error(`${label} failed: ${JSON.stringify((res.effects as any)?.status)}`);
  }
  return { label, digest: res.digest, objectChanges: res.objectChanges ?? undefined };
}

export async function fundPair(alice: string, bob: string): Promise<void> {
  const res = await fetch(CONFIG.fundEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addresses: [alice, bob] }),
  });
  if (!res.ok) throw new Error(`fund failed (${res.status}): ${await res.text()}`);
}

export async function suiBalance(addr: string): Promise<bigint> {
  const b = await client.getBalance({ owner: addr, coinType: "0x2::sui::SUI" });
  return BigInt(b.totalBalance);
}

export async function createTunnel(
  alice: Ed25519Keypair,
  bob: Ed25519Keypair,
): Promise<{ tunnelId: string; tx: ChainTx }> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CONFIG.packageId}::channel::create_and_share`,
    arguments: [
      tx.pure.address(alice.toSuiAddress()),
      tx.pure.vector("u8", pubRaw(alice)),
      tx.pure.address(bob.toSuiAddress()),
      tx.pure.vector("u8", pubRaw(bob)),
      tx.pure.u64(BigInt(CONFIG.disputeWindowMs)),
      tx.object(CONFIG.clock),
    ],
  });
  const res = await exec(alice, tx, "create tunnel");
  const created = res.objectChanges?.find(
    (o: any) => o.objectType === `${CONFIG.packageId}::channel::Tunnel`,
  );
  if (!created) throw new Error("tunnel object not found in tx result");
  return { tunnelId: created.objectId, tx: { label: res.label, digest: res.digest } };
}

export async function depositTo(
  tunnelId: string,
  who: Ed25519Keypair,
  amount: bigint,
  label: string,
): Promise<ChainTx> {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
  tx.moveCall({
    target: `${CONFIG.packageId}::channel::deposit`,
    arguments: [tx.object(tunnelId), coin, tx.object(CONFIG.clock)],
  });
  return exec(who, tx, label);
}

// One OFF-CHAIN co-signed update. No transaction — just two signatures.
export async function coSign(
  alice: Ed25519Keypair,
  bob: Ed25519Keypair,
  tunnelId: string,
  nonce: number,
  a: bigint,
  b: bigint,
  memo: string,
): Promise<SignedState> {
  const ts = Date.now();
  const hash = new TextEncoder().encode(memo.padEnd(32, "0")).slice(0, 32);
  const msg = StateUpdateData.serialize({
    tunnel_id: tunnelId,
    state_hash: Array.from(hash),
    nonce: BigInt(nonce),
    timestamp: BigInt(ts),
    party_a_balance: a,
    party_b_balance: b,
  }).toBytes();
  const sigA = await alice.sign(msg);
  const sigB = await bob.sign(msg);
  return { nonce, ts, a, b, hash, sigA, sigB };
}

function stateArgs(tx: Transaction, s: SignedState) {
  return [
    tx.pure.u64(s.a),
    tx.pure.u64(s.b),
    tx.pure.u64(BigInt(s.nonce)),
    tx.pure.vector("u8", Array.from(s.hash)),
    tx.pure.u64(BigInt(s.ts)),
    tx.pure.vector("u8", Array.from(s.sigA)),
    tx.pure.vector("u8", Array.from(s.sigB)),
  ];
}

export async function closeCooperative(
  tunnelId: string,
  sender: Ed25519Keypair,
  s: SignedState,
): Promise<ChainTx> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CONFIG.packageId}::channel::close_cooperative`,
    arguments: [tx.object(tunnelId), ...stateArgs(tx, s), tx.object(CONFIG.clock)],
  });
  return exec(sender, tx, "settle (cooperative close)");
}

export async function raiseDispute(
  tunnelId: string,
  sender: Ed25519Keypair,
  s: SignedState,
): Promise<ChainTx> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CONFIG.packageId}::channel::raise_dispute`,
    arguments: [tx.object(tunnelId), ...stateArgs(tx, s), tx.object(CONFIG.clock)],
  });
  return exec(sender, tx, `raise dispute (stale nonce ${s.nonce})`);
}

export async function resolveDispute(
  tunnelId: string,
  sender: Ed25519Keypair,
  s: SignedState,
): Promise<ChainTx> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CONFIG.packageId}::channel::resolve_dispute`,
    arguments: [tx.object(tunnelId), ...stateArgs(tx, s), tx.object(CONFIG.clock)],
  });
  return exec(sender, tx, `override with newer state (nonce ${s.nonce})`);
}

export async function forceClose(tunnelId: string, sender: Ed25519Keypair): Promise<ChainTx> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CONFIG.packageId}::channel::force_close`,
    arguments: [tx.object(tunnelId), tx.object(CONFIG.clock)],
  });
  return exec(sender, tx, "force close (after timeout)");
}
