// Dev-server /api/fund endpoint.
//
// Funds the demo's freshly generated Alice/Bob keypairs with a little testnet
// SUI from a funder wallet (SPONSOR_KEY env). The key never reaches the browser.
// In production the same logic runs as a Vercel function (../api/fund.js).

import type { Connect } from "vite";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

const RPC = "https://sui-testnet-rpc.publicnode.com";
const AMOUNT = 100_000_000n; // 0.1 SUI each (real gas is ~0.003/tx)

export function fundPlugin() {
  return {
    name: "tunnel-fund-endpoint",
    configureServer(server: { middlewares: Connect.Server }) {
      const key = process.env.SPONSOR_KEY;
      if (!key) {
        console.warn("\n⚠️  SPONSOR_KEY not set — /api/fund will return 503.");
        console.warn("   Run:  SPONSOR_KEY=suiprivkey1... pnpm dev\n");
      }
      server.middlewares.use("/api/fund", async (req, res) => {
        res.setHeader("content-type", "application/json");
        if (!key) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "funder not configured (set SPONSOR_KEY)" }));
          return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const { addresses } = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 2) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "expected { addresses: [a, b] }" }));
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
          res.end(JSON.stringify({ digest: out.digest, funder: funder.getPublicKey().toSuiAddress() }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
    },
  };
}
