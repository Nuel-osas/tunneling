// Vercel serverless function: POST /api/fund
// Funds the demo's freshly generated Alice/Bob keypairs with testnet SUI.
// Set SPONSOR_KEY (suiprivkey1..., a funded TESTNET key) in Vercel env.

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

const RPC = "https://sui-testnet-rpc.publicnode.com";
const AMOUNT = 100_000_000n; // 0.1 SUI each (real gas is ~0.003/tx)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const key = process.env.SPONSOR_KEY;
  if (!key) {
    res.status(503).json({ error: "funder not configured (set SPONSOR_KEY in Vercel env)" });
    return;
  }
  try {
    const { addresses } = req.body ?? {};
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 2) {
      res.status(400).json({ error: "expected { addresses: [a, b] }" });
      return;
    }
    const client = new SuiClient({ url: RPC });
    const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(key.trim()).secretKey);
    const tx = new Transaction();
    for (const addr of addresses) {
      const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(AMOUNT)]);
      tx.transferObjects([c], tx.pure.address(addr));
    }
    tx.setGasBudget(20_000_000n);
    const out = await client.signAndExecuteTransaction({
      signer: funder,
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: out.digest });
    res.status(200).json({ digest: out.digest, funder: funder.getPublicKey().toSuiAddress() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
