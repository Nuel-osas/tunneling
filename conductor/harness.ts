// Multisig/BLS tunnel-conductor PoC — drives the LIVE Sui Programmable Tunnels
// contract (testnet pkg 0x7bc4229…) to prove a GROUP can be a tunnel party.
//
// EXP1: party_a ed25519, party_b ed25519  -> validates the 86-byte close preimage
//       + the open→cosign→close flow against the real contract.
// EXP2: party_a ed25519, party_b = BLS-AGGREGATE GROUP of 3 -> the headline:
//       three members co-sign the SAME state; their aggregate is ONE party_b
//       signature that the contract's native BLS min_pk verify accepts.
//
// Tunnels are opened UNFUNDED via entry_create_and_share (no MTPS needed); we
// prove the signature-verification path, not fund movement (balances 0/0).
//
// Signed preimage (reverse-engineered from bytecode), 86 bytes, RAW (no hashing
// by us — the verify natives hash internally):
//   "sui_tunnel::settlement"(22) || tunnelId(32) || u64be(balA) || u64be(balB)
//     || u64be(final_nonce = on_chain_nonce+1) || u64be(timestamp)

import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { toHex } from '@mysten/sui/utils'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const RPC = 'https://rpc-testnet.suiscan.xyz'
const PKG = '0x7bc4229270cd186434c39a65f9c93933edf8156acac8d1ad288dedfc9d5ccf2c'
const COIN_T = '0x2::sui::SUI'
const CLOCK = '0x6'
const client = new SuiClient({ url: RPC })

// signature_type constants (from bytecode): ed25519=0, bls_min_sig=1, bls_min_pk=2, secp256k1=3
const SIG = { ed25519: 0, bls_min_sig: 1, bls_min_pk: 2, secp256k1: 3 }
// Sui min_pk = signatures in G2; DST must match fastcrypto's basic ciphersuite.
const SUI_BLS_DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_'
const ls = bls.longSignatures // min_pk: 48B G1 pubkey, 96B G2 signature
const bytesOf = (p: any): Uint8Array => (p.toBytes ? p.toBytes() : p.toRawBytes())

const DOMAIN_SETTLE = new TextEncoder().encode('sui_tunnel::settlement') // 22 bytes
const u64be = (n: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, false)
  return b
}
function settlementPreimage(tunnelId: Uint8Array, balA: bigint, balB: bigint, finalNonce: bigint, ts: bigint) {
  const out = new Uint8Array(22 + 32 + 8 * 4)
  let o = 0
  out.set(DOMAIN_SETTLE, o); o += 22
  out.set(tunnelId, o); o += 32
  out.set(u64be(balA), o); o += 8
  out.set(u64be(balB), o); o += 8
  out.set(u64be(finalNonce), o); o += 8
  out.set(u64be(ts), o); o += 8
  return out
}

interface Party { pubkey: Uint8Array; sigType: number; address: string; sign: (m: Uint8Array) => Promise<Uint8Array> }

function edParty(kp: Ed25519Keypair): Party {
  return {
    pubkey: kp.getPublicKey().toRawBytes(), // 32B
    sigType: SIG.ed25519,
    address: kp.toSuiAddress(),
    sign: async (m) => await kp.sign(m), // RAW ed25519, 64B
  }
}

function blsGroupParty(n: number, payoutAddr: string): Party {
  const sks = Array.from({ length: n }, () => bls.utils.randomSecretKey())
  const aggPk = bytesOf(ls.aggregatePublicKeys(sks.map((sk) => ls.getPublicKey(sk)))) // 48B
  return {
    pubkey: aggPk,
    sigType: SIG.bls_min_pk,
    address: payoutAddr,
    sign: async (m) => {
      const pt = ls.hash(m, SUI_BLS_DST) // hash msg -> G2 with Sui's DST
      const parts = sks.map((sk) => ls.sign(pt, sk)) // each member signs same message
      return bytesOf(ls.aggregateSignatures(parts)) // aggregate -> one 96B signature
    },
  }
}

function loadExecutor(): Ed25519Keypair {
  const active = process.env.ACTIVE_ADDR!
  const keys: string[] = JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, 'utf8'))
  for (const k of keys) {
    const raw = Buffer.from(k, 'base64')
    if (raw[0] !== 0) continue // ed25519 only
    const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))
    if (kp.toSuiAddress() === active) return kp
  }
  throw new Error('active key not found in keystore')
}

async function openTunnel(exec: Ed25519Keypair, a: Party, b: Party) {
  const tx = new Transaction()
  tx.moveCall({
    target: `${PKG}::tunnel::entry_create_and_share`,
    typeArguments: [COIN_T],
    arguments: [
      tx.pure.address(a.address), tx.pure.vector('u8', Array.from(a.pubkey)), tx.pure.u8(a.sigType),
      tx.pure.address(b.address), tx.pure.vector('u8', Array.from(b.pubkey)), tx.pure.u8(b.sigType),
      tx.pure.u64(1000n), tx.pure.u64(1000n), // declared deposits (>0 required; balance stays 0)
      tx.object(CLOCK),
    ],
  })
  const res = await client.signAndExecuteTransaction({
    signer: exec, transaction: tx, options: { showEffects: true, showObjectChanges: true },
  })
  await client.waitForTransaction({ digest: res.digest })
  if (res.effects?.status.status !== 'success') throw new Error('open failed: ' + JSON.stringify(res.effects?.status))
  const created = res.objectChanges?.find(
    (c: any) => c.type === 'created' && String(c.objectType).includes('::tunnel::Tunnel<'),
  ) as any
  return created.objectId as string
}

async function closeCooperative(exec: Ed25519Keypair, tunnelId: string, a: Party, b: Party) {
  const obj = await client.getObject({ id: tunnelId, options: { showContent: true } })
  const f: any = (obj.data?.content as any).fields
  const nonce = BigInt(f.state.fields.nonce)
  const createdAt = BigInt(f.created_at)
  const finalNonce = nonce + 1n
  const ts = createdAt // guaranteed created_at <= ts <= clock.now
  const idBytes = new Uint8Array(Buffer.from(tunnelId.replace(/^0x/, ''), 'hex'))
  const msg = settlementPreimage(idBytes, 0n, 0n, finalNonce, ts)
  const sigA = await a.sign(msg)
  const sigB = await b.sign(msg)

  const tx = new Transaction()
  tx.moveCall({
    target: `${PKG}::tunnel::entry_close_cooperative`,
    typeArguments: [COIN_T],
    arguments: [
      tx.object(tunnelId), tx.pure.u64(0n), tx.pure.u64(0n),
      tx.pure.vector('u8', Array.from(sigA)), tx.pure.vector('u8', Array.from(sigB)),
      tx.pure.u64(ts), tx.object(CLOCK),
    ],
  })
  const res = await client.signAndExecuteTransaction({
    signer: exec, transaction: tx, options: { showEffects: true },
  })
  await client.waitForTransaction({ digest: res.digest })
  return { status: res.effects?.status, digest: res.digest }
}

async function runExperiment(label: string, exec: Ed25519Keypair, a: Party, b: Party) {
  console.log(`\n━━━ ${label} ━━━`)
  console.log(`  party_a: sigType=${a.sigType} (${a.pubkey.length}B pk)`)
  console.log(`  party_b: sigType=${b.sigType} (${b.pubkey.length}B pk)${b.sigType === SIG.bls_min_pk ? '  ← BLS-AGGREGATE GROUP' : ''}`)
  const tunnelId = await openTunnel(exec, a, b)
  console.log(`  ✓ opened tunnel ${tunnelId}`)
  const { status, digest } = await closeCooperative(exec, tunnelId, a, b)
  const ok = status?.status === 'success'
  console.log(`  ${ok ? '✅ CLOSE VERIFIED' : '❌ close failed'} — ${JSON.stringify(status)}`)
  console.log(`  close tx: ${digest}`)
  return ok
}

async function main() {
  const exec = loadExecutor()
  console.log('executor / party_a:', exec.toSuiAddress())
  const partyA = edParty(exec) // funded key doubles as party_a

  // EXP1 — ed25519 / ed25519 (validates preimage + flow)
  const counterEd = Ed25519Keypair.generate()
  const okEd = await runExperiment('EXP1  ed25519 ⇄ ed25519', exec, partyA, edParty(counterEd))

  // EXP2 — ed25519 / BLS-aggregate group of 3 (the headline)
  const group = blsGroupParty(3, Ed25519Keypair.generate().toSuiAddress())
  console.log('\nBLS group aggPk (48B):', toHex(group.pubkey))
  const okBls = await runExperiment('EXP2  ed25519 ⇄ BLS group(3)', exec, partyA, group)

  console.log('\n════════ RESULT ════════')
  console.log(`  ed25519 tunnel close:      ${okEd ? 'WORKS' : 'FAILED'}`)
  console.log(`  BLS-group tunnel close:    ${okBls ? 'WORKS — a group is a tunnel party ✅' : 'FAILED'}`)
}

main().catch((e) => { console.error('FATAL:', e?.message ?? e); process.exit(1) })
