import { useMemo, useRef, useState } from "react";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  ChainTx,
  SignedState,
  closeCooperative,
  coSign,
  createTunnel,
  depositTo,
  forceClose,
  fundPair,
  raiseDispute,
  resolveDispute,
  suiBalance,
} from "./lib/tunnel";
import { CONFIG, explorerTx, fmt } from "./config";

type Phase =
  | "idle"
  | "funding"
  | "funded"
  | "opening"
  | "active"
  | "settling"
  | "cheating"
  | "countdown"
  | "closed";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function App() {
  // two in-browser parties — generated fresh per session
  const alice = useMemo(() => Ed25519Keypair.generate(), []);
  const bob = useMemo(() => Ed25519Keypair.generate(), []);
  const A = alice.toSuiAddress();
  const B = bob.toSuiAddress();

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Two fresh keypairs generated in your browser. Fund them to begin.");
  const [tunnelId, setTunnelId] = useState<string | null>(null);
  const [states, setStates] = useState<SignedState[]>([]);
  const [txs, setTxs] = useState<ChainTx[]>([]);
  const [balA, setBalA] = useState<bigint>(CONFIG.deposit);
  const [balB, setBalB] = useState<bigint>(CONFIG.deposit);
  const [countdown, setCountdown] = useState(0);
  const [finalNote, setFinalNote] = useState<string | null>(null);
  const busyRef = useRef(false);

  const latest = states[states.length - 1] ?? null;
  const busy = ["funding", "opening", "settling", "cheating"].includes(phase);

  const addTx = (t: ChainTx) => setTxs((p) => [...p, { label: t.label, digest: t.digest }]);

  async function run(label: string, fn: () => Promise<void>, next: Phase) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setStatus(label + "…");
      await fn();
      setPhase(next);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
      setPhase((p) => (p === "funding" ? "idle" : p === "opening" ? "funded" : "active"));
    } finally {
      busyRef.current = false;
    }
  }

  const doFund = () =>
    run(
      "Funding Alice & Bob with testnet SUI (one funder tx)",
      async () => {
        setPhase("funding");
        await fundPair(A, B);
        // the RPC's coin index can lag a beat behind execution — wait until both
        // parties can actually see their gas before enabling the next step
        for (let i = 0; i < 20; i++) {
          const [ba, bb] = await Promise.all([suiBalance(A), suiBalance(B)]);
          if (ba > 0n && bb > 0n) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        setStatus("Funded. Now open the tunnel — the FIRST of only two on-chain transactions.");
      },
      "funded",
    );

  const doOpen = () =>
    run(
      "Opening the tunnel on-chain (create + two deposits)",
      async () => {
        setPhase("opening");
        const { tunnelId: id, tx } = await createTunnel(alice, bob);
        addTx(tx);
        setTunnelId(id);
        setStatus("Tunnel created. Depositing both sides…");
        addTx(await depositTo(id, alice, CONFIG.deposit, "Alice deposits 0.05"));
        addTx(await depositTo(id, bob, CONFIG.deposit, "Bob deposits 0.05"));
        setStatus(
          "Tunnel ACTIVE, pot 0.100. Everything you do next is OFF-CHAIN — watch the counters.",
        );
      },
      "active",
    );

  async function pay(from: "A" | "B") {
    if (busyRef.current || !tunnelId) return;
    const step = CONFIG.payStep;
    const na = from === "A" ? balA - step : balA + step;
    const nb = from === "A" ? balB + step : balB - step;
    if (na < 0n || nb < 0n) {
      setStatus("Not enough in that side's balance.");
      return;
    }
    busyRef.current = true;
    try {
      const nonce = (latest?.nonce ?? 0) + 1;
      const s = await coSign(alice, bob, tunnelId, nonce, na, nb, `update-${nonce}`);
      setStates((p) => [...p, s]);
      setBalA(na);
      setBalB(nb);
      setStatus(
        `Update #${nonce} co-signed by BOTH parties — instantly, no transaction, no fee.`,
      );
    } finally {
      busyRef.current = false;
    }
  }

  const doSettle = () =>
    run(
      "Settling on-chain at the latest co-signed state",
      async () => {
        if (!tunnelId || !latest) throw new Error("nothing to settle");
        setPhase("settling");
        const t = await closeCooperative(tunnelId, alice, latest);
        addTx(t);
        setFinalNote(
          `Settled at nonce ${latest.nonce}: Alice ${fmt(latest.a)} · Bob ${fmt(latest.b)}. ` +
            `${states.length} updates happened off-chain — the chain saw only open + settle.`,
        );
        setStatus("Done. Check the on-chain ledger below — count the transactions.");
      },
      "closed",
    );

  const doCheat = () =>
    run(
      "Bob tries to cheat — posting the OLD state #1 on-chain",
      async () => {
        if (!tunnelId || states.length < 2) throw new Error("make at least 2 updates first");
        setPhase("cheating");
        const stale = states[0];
        addTx(await raiseDispute(tunnelId, bob, stale));
        setStatus(
          `Bob posted stale nonce ${stale.nonce} (better for him). Alice is watching — she overrides…`,
        );
        const newest = states[states.length - 1];
        addTx(await resolveDispute(tunnelId, alice, newest));
        setStatus(
          `Alice overrode with nonce ${newest.nonce}. Now the ${CONFIG.disputeWindowMs / 1000}s dispute window must pass…`,
        );
        // countdown then force close
        setPhase("countdown");
        const secs = Math.ceil(CONFIG.disputeWindowMs / 1000) + 3;
        for (let i = secs; i > 0; i--) {
          setCountdown(i);
          await new Promise((r) => setTimeout(r, 1000));
        }
        setCountdown(0);
        setStatus("Window closed. Anyone can now force-close at the HIGHEST nonce…");
        const t = await forceClose(tunnelId, alice);
        addTx(t);
        setFinalNote(
          `Force-closed at nonce ${newest.nonce} — the newest co-signed state. Bob's cheat gained him nothing.`,
        );
        setStatus("Dispute resolved. The cheater lost. Check the ledger below.");
      },
      "closed",
    );

  const offchain = states.length;
  const onchain = txs.length;

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="kicker">Sui Stack 2026 · Day 3 · live on testnet</p>
          <h1>Tunnel Playground</h1>
          <p className="sub">
            Two parties, one channel. Real transactions to <b>open</b> and <b>settle</b> — and
            everything between is just signatures.
          </p>
        </div>
        <div className="counters">
          <div className="counter off">
            <span className="cnum">{offchain}</span>
            <span className="clab">off-chain updates<br />(free, instant)</span>
          </div>
          <div className="counter on">
            <span className="cnum">{onchain}</span>
            <span className="clab">on-chain txs<br />(the slow part)</span>
          </div>
        </div>
      </header>

      <div className="status" data-phase={phase}>
        {countdown > 0 ? `⏳ dispute window: ${countdown}s — waiting so the timeout can pass… ` : status}
      </div>

      <main className="grid">
        {/* ALICE */}
        <section className="party alice">
          <h3>Alice</h3>
          <p className="addr mono">{short(A)}</p>
          <div className="bal">
            <span className="blab">in-tunnel balance</span>
            <span className="bnum">{tunnelId ? fmt(balA) : "—"}</span>
          </div>
          <button disabled={phase !== "active" || busy} onClick={() => pay("A")}>
            Pay Bob {fmt(CONFIG.payStep)} →
          </button>
        </section>

        {/* NOTEPAD */}
        <section className="notepad">
          <h3>The notepad — co-signed states</h3>
          <p className="hint">Each row = one OFF-CHAIN update, signed by both. Newest (highest nonce) wins.</p>
          <div className="pages">
            {states.length === 0 && <p className="empty">No updates yet.</p>}
            {states.map((s) => (
              <div key={s.nonce} className={`pagerow ${latest?.nonce === s.nonce ? "hi" : ""}`}>
                <span className="pnonce mono">#{s.nonce}</span>
                <span className="psplit mono">
                  A {fmt(s.a)} · B {fmt(s.b)}
                </span>
                <span className="psigs">✍A ✍B</span>
              </div>
            ))}
          </div>

          <div className="actions">
            {phase === "idle" && (
              <button className="primary" onClick={doFund}>1 · Fund Alice &amp; Bob</button>
            )}
            {phase === "funded" && (
              <button className="primary" onClick={doOpen}>2 · Open the tunnel (on-chain)</button>
            )}
            {phase === "active" && (
              <>
                <button className="primary" disabled={states.length === 0 || busy} onClick={doSettle}>
                  3 · Settle (on-chain, once)
                </button>
                <button className="danger" disabled={states.length < 2 || busy} onClick={doCheat}>
                  😈 Simulate Bob cheating
                </button>
              </>
            )}
            {(phase === "funding" || phase === "opening" || phase === "settling" || phase === "cheating") && (
              <button className="primary" disabled>working…</button>
            )}
            {phase === "closed" && <p className="done">✅ {finalNote}</p>}
          </div>
        </section>

        {/* BOB */}
        <section className="party bob">
          <h3>Bob</h3>
          <p className="addr mono">{short(B)}</p>
          <div className="bal">
            <span className="blab">in-tunnel balance</span>
            <span className="bnum">{tunnelId ? fmt(balB) : "—"}</span>
          </div>
          <button disabled={phase !== "active" || busy} onClick={() => pay("B")}>
            ← Pay Alice {fmt(CONFIG.payStep)}
          </button>
        </section>
      </main>

      <section className="ledger">
        <h3>The on-chain ledger — every transaction this session</h3>
        {txs.length === 0 && <p className="empty">Nothing yet. The chain hasn't been touched.</p>}
        <ol>
          {txs.map((t) => (
            <li key={t.digest}>
              <span>{t.label}</span>
              <a href={explorerTx(t.digest)} target="_blank" rel="noreferrer" className="mono">
                {t.digest.slice(0, 10)}… ↗
              </a>
            </li>
          ))}
        </ol>
      </section>

      <footer className="foot">
        tunnels_edu::channel on testnet · <span className="mono">{short(CONFIG.packageId)}</span> ·
        SuiHub Lagos · github.com/Nuel-osas/tunneling
      </footer>
    </div>
  );
}
