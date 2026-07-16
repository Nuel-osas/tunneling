import { useEffect, useMemo, useRef, useState } from "react";
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
  hashTranscript,
  raiseDispute,
  resolveDispute,
  suiBalance,
  sweepAll,
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

type Mode = "pay" | "chat" | "stream" | "game";

interface Ev {
  kind: "pay" | "msg" | "tick" | "rps";
  by: "A" | "B";
  text?: string;
  detail?: string;
  ts: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const RPS = ["✊", "✋", "✌️"] as const;

export default function App() {
  const alice = useMemo(() => Ed25519Keypair.generate(), []);
  const bob = useMemo(() => Ed25519Keypair.generate(), []);
  const A = alice.toSuiAddress();
  const B = bob.toSuiAddress();

  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<Mode>("pay");
  const [status, setStatus] = useState("Two fresh keypairs generated in your browser. Fund them to begin.");
  const [tunnelId, setTunnelId] = useState<string | null>(null);
  const [states, setStates] = useState<SignedState[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [txs, setTxs] = useState<ChainTx[]>([]);
  const [balA, setBalA] = useState<bigint>(CONFIG.deposit);
  const [balB, setBalB] = useState<bigint>(CONFIG.deposit);
  const [countdown, setCountdown] = useState(0);
  const [finalNote, setFinalNote] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sponsorAddr, setSponsorAddr] = useState<string>(CONFIG.sponsorAddress);
  const [swept, setSwept] = useState(false);
  const busyRef = useRef(false);
  const stateRef = useRef({ balA, balB, states, events, tunnelId });
  stateRef.current = { balA, balB, states, events, tunnelId };

  const latest = states[states.length - 1] ?? null;
  const busy = ["funding", "opening", "settling", "cheating"].includes(phase);
  const addTx = (t: ChainTx) => setTxs((p) => [...p, { label: t.label, digest: t.digest }]);

  // ---- one off-chain co-signed update: shift balances + commit the transcript ----
  async function update(shift: bigint, ev: Ev, note: string): Promise<boolean> {
    const { balA: a0, balB: b0, states: st, events: evs, tunnelId: id } = stateRef.current;
    if (!id) return false;
    const na = a0 + shift;
    const nb = b0 - shift;
    if (na < 0n || nb < 0n) {
      setStatus("That side's balance is empty — settle or send the other way.");
      return false;
    }
    const transcript = [...evs, ev];
    const hash = await hashTranscript(transcript);
    const nonce = (st[st.length - 1]?.nonce ?? 0) + 1;
    const s = await coSign(alice, bob, id, nonce, na, nb, hash);
    setStates((p) => [...p, s]);
    setEvents(transcript);
    setBalA(na);
    setBalB(nb);
    setStatus(note.replace("{n}", String(nonce)));
    return true;
  }

  // ---- lifecycle ----
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
        const fr = await fundPair(A, B);
        if (fr.funder) setSponsorAddr(fr.funder);
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
        setStatus("Tunnel ACTIVE, pot 0.100. Try the tabs — pay, chat, stream, play. All off-chain.");
      },
      "active",
    );

  const doSettle = () =>
    run(
      "Settling on-chain at the latest co-signed state",
      async () => {
        if (!tunnelId || !latest) throw new Error("nothing to settle — make at least one update");
        setStreaming(false);
        setPhase("settling");
        const t = await closeCooperative(tunnelId, alice, latest);
        addTx(t);
        setFinalNote(
          `Settled at nonce ${latest.nonce}: Alice ${fmt(latest.a)} · Bob ${fmt(latest.b)}. ` +
            `${states.length} updates (payments, messages, ticks, moves) happened off-chain — ` +
            `the chain saw only their fingerprint.`,
        );
        setStatus("Done. Count the on-chain transactions below.");
      },
      "closed",
    );

  const doCheat = () =>
    run(
      "Bob tries to cheat — posting an OLD state on-chain",
      async () => {
        if (!tunnelId || states.length < 2) throw new Error("make at least 2 updates first");
        setStreaming(false);
        setPhase("cheating");
        const stale = states[0];
        addTx(await raiseDispute(tunnelId, bob, stale));
        setStatus(`Bob posted stale nonce ${stale.nonce}. Alice is watching — she overrides…`);
        const newest = states[states.length - 1];
        addTx(await resolveDispute(tunnelId, alice, newest));
        setStatus(`Alice overrode with nonce ${newest.nonce}. Waiting out the dispute window…`);
        setPhase("countdown");
        const secs = Math.ceil(CONFIG.disputeWindowMs / 1000) + 3;
        for (let i = secs; i > 0; i--) {
          setCountdown(i);
          await new Promise((r) => setTimeout(r, 1000));
        }
        setCountdown(0);
        setStatus("Window closed. Force-closing at the HIGHEST nonce…");
        addTx(await forceClose(tunnelId, alice));
        setFinalNote(
          `Force-closed at nonce ${newest.nonce} — the newest co-signed state. Bob's cheat gained him nothing.`,
        );
        setStatus("Dispute resolved. The cheater lost.");
      },
      "closed",
    );

  const doRecover = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setStatus("Recovering leftover SUI back to the sponsor wallet…");
      // payout coins can take a beat to index after settle — wait until visible
      for (let i = 0; i < 12; i++) {
        const [ba, bb] = await Promise.all([suiBalance(A), suiBalance(B)]);
        if (ba > 35_000_000n || bb > 35_000_000n) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      let recovered = 0n;
      for (const [kp, name] of [[alice, "Alice"], [bob, "Bob"]] as const) {
        const before = await suiBalance(kp.toSuiAddress());
        const t = await sweepAll(kp, sponsorAddr, `♻ ${name} returns leftovers to sponsor`);
        if (t) {
          addTx(t);
          recovered += before;
        }
      }
      setSwept(true);
      if (phase === "funded") {
        // cancelled before opening — the session is over
        setPhase("closed");
        setFinalNote("Session cancelled — funds recovered to the sponsor. Refresh the page for a new session.");
      }
      setStatus(
        recovered > 0n
          ? `♻ Recovered ~${fmt(recovered)} SUI back to the sponsor (${short(sponsorAddr)}). Session fully cleaned up.`
          : "Nothing left to recover (balances were dust).",
      );
    } catch (e) {
      setStatus(`❌ recover failed: ${(e as Error).message}`);
    } finally {
      busyRef.current = false;
    }
  };

  // ---- use cases ----
  const pay = (from: "A" | "B") =>
    guard(() =>
      update(
        from === "A" ? -CONFIG.payStep : CONFIG.payStep,
        { kind: "pay", by: from, detail: fmt(CONFIG.payStep), ts: Date.now() },
        `Update #{n}: ${from === "A" ? "Alice paid Bob" : "Bob paid Alice"} ${fmt(CONFIG.payStep)} — co-signed, off-chain.`,
      ),
    );

  const sendMsg = (from: "A" | "B") =>
    guard(async () => {
      const text = chatText.trim();
      if (!text) return;
      const fee = 1_000_000n; // pay-per-message: 0.001 rides along with every text
      await update(
        from === "A" ? -fee : fee,
        { kind: "msg", by: from, text, ts: Date.now() },
        `Message #{n} co-signed. It exists ONLY between the two parties — the chain will only ever see its fingerprint.`,
      );
      setChatText("");
    });

  const playRps = (aliceMove: number) =>
    guard(async () => {
      const bobMove = Math.floor(Math.random() * 3);
      const diff = (aliceMove - bobMove + 3) % 3;
      const stake = 2_000_000n; // 0.002 per round
      const shift = diff === 1 ? stake : diff === 2 ? -stake : 0n;
      const result = diff === 0 ? "draw" : diff === 1 ? "Alice wins" : "Bob wins";
      await update(
        shift,
        { kind: "rps", by: "A", detail: `${RPS[aliceMove]} vs ${RPS[bobMove]} — ${result}`, ts: Date.now() },
        `Round #{n}: ${RPS[aliceMove]} vs ${RPS[bobMove]} → ${result}${diff === 0 ? "" : ", pot shifts 0.002"} — off-chain.`,
      );
    });

  function guard(fn: () => Promise<unknown>) {
    if (busyRef.current || phase !== "active") return;
    busyRef.current = true;
    fn().finally(() => (busyRef.current = false));
  }

  // streaming: one co-signed micro-payment per second while the switch is on
  useEffect(() => {
    if (!streaming || phase !== "active") return;
    const iv = setInterval(() => {
      if (busyRef.current) return;
      busyRef.current = true;
      update(
        -1_000_000n,
        { kind: "tick", by: "A", ts: Date.now() },
        "Streaming: update #{n} — Alice pays 0.001/second, co-signed every tick, zero transactions.",
      )
        .then((ok) => {
          if (!ok) setStreaming(false);
        })
        .finally(() => (busyRef.current = false));
    }, 1000);
    return () => clearInterval(iv);
  }, [streaming, phase]);

  const offchain = states.length;
  const onchain = txs.length;
  const msgs = events.filter((e) => e.kind === "msg");
  const hashHex = latest ? Array.from(latest.hash.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("") : null;

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="kicker">Sui Stack 2026 · Day 3 · live on testnet</p>
          <h1>Tunnel Playground</h1>
          <p className="sub">
            One channel, four apps — payments, chat, streaming, a game. Real transactions to{" "}
            <b>open</b> and <b>settle</b>; everything between is just signatures.
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
        {countdown > 0 ? `⏳ dispute window: ${countdown}s — waiting so the timeout can pass…` : status}
      </div>

      <main className="grid">
        <section className="party alice">
          <h3>Alice</h3>
          <p className="addr mono">{short(A)}</p>
          <div className="bal">
            <span className="blab">in-tunnel balance</span>
            <span className="bnum">{tunnelId ? fmt(balA) : "—"}</span>
          </div>
        </section>

        <section className="notepad">
          <div className="tabs">
            {(["pay", "chat", "stream", "game"] as Mode[]).map((m) => (
              <button
                key={m}
                className={`tab ${mode === m ? "on" : ""}`}
                onClick={() => setMode(m)}
              >
                {m === "pay" ? "💸 Pay" : m === "chat" ? "💬 Chat" : m === "stream" ? "⏱ Stream" : "✊ Game"}
              </button>
            ))}
          </div>

          {mode === "pay" && (
            <div className="pane">
              <p className="hint">Each press = one co-signed balance update. No transaction, no fee, instant.</p>
              <div className="row2">
                <button className="act alice" disabled={phase !== "active"} onClick={() => pay("A")}>
                  Alice pays Bob {fmt(CONFIG.payStep)} →
                </button>
                <button className="act bob" disabled={phase !== "active"} onClick={() => pay("B")}>
                  ← Bob pays Alice {fmt(CONFIG.payStep)}
                </button>
              </div>
            </div>
          )}

          {mode === "chat" && (
            <div className="pane">
              <p className="hint">
                Every message is co-signed and costs 0.001 (pay-per-message). The words never touch the
                chain — only their <b>fingerprint</b> does.
              </p>
              <div className="chatbox">
                {msgs.length === 0 && <p className="empty">No messages yet.</p>}
                {msgs.map((m, i) => (
                  <div key={i} className={`bubble ${m.by === "A" ? "a" : "b"}`}>
                    <span className="who">{m.by === "A" ? "Alice" : "Bob"}</span>
                    {m.text}
                  </div>
                ))}
              </div>
              <div className="chatrow">
                <input
                  className="input"
                  placeholder="type a message…"
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  disabled={phase !== "active"}
                />
                <button className="act alice" disabled={phase !== "active" || !chatText.trim()} onClick={() => sendMsg("A")}>
                  as Alice
                </button>
                <button className="act bob" disabled={phase !== "active" || !chatText.trim()} onClick={() => sendMsg("B")}>
                  as Bob
                </button>
              </div>
              {hashHex && (
                <p className="fingerprint mono">chain will only ever see: {hashHex}…</p>
              )}
            </div>
          )}

          {mode === "stream" && (
            <div className="pane">
              <p className="hint">
                Pay-as-you-go: while the stream is on, Alice pays Bob <b>0.001 every second</b> — one
                co-signed update per tick. Watch the counter fly. This is the "6M TPS".
              </p>
              <button
                className={`act stream ${streaming ? "live" : ""}`}
                disabled={phase !== "active"}
                onClick={() => setStreaming((s) => !s)}
              >
                {streaming ? "◼ Stop streaming" : "▶ Start streaming (0.001/s)"}
              </button>
            </div>
          )}

          {mode === "game" && (
            <div className="pane">
              <p className="hint">
                Rock-paper-scissors, 0.002 a round — the gaming pattern in miniature. You play Alice;
                Bob answers instantly. Every round is a co-signed state, winner takes the round.
              </p>
              <div className="row3">
                {RPS.map((r, i) => (
                  <button key={r} className="act rps" disabled={phase !== "active"} onClick={() => playRps(i)}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="pages">
            {states.length === 0 && <p className="empty">No updates yet — the notepad is blank.</p>}
            {states.slice(-30).map((s) => {
              const ev = events[s.nonce - 1];
              const icon = ev?.kind === "msg" ? "💬" : ev?.kind === "tick" ? "⏱" : ev?.kind === "rps" ? "✊" : "💸";
              return (
                <div key={s.nonce} className={`pagerow ${latest?.nonce === s.nonce ? "hi" : ""}`}>
                  <span className="pnonce mono">#{s.nonce}</span>
                  <span className="picon">{icon}</span>
                  <span className="psplit mono">A {fmt(s.a)} · B {fmt(s.b)}</span>
                  <span className="psigs">✍A ✍B</span>
                </div>
              );
            })}
          </div>

          <div className="actions">
            {phase === "idle" && <button className="primary" onClick={doFund}>1 · Fund Alice &amp; Bob</button>}
            {phase === "funded" && (
              <>
                <button className="primary" onClick={doOpen}>2 · Open the tunnel (on-chain)</button>
                <button className="recover" onClick={doRecover}>
                  ♻ Cancel — recover the SUI to the sponsor
                </button>
              </>
            )}
            {phase === "active" && (
              <>
                <button className="primary" disabled={states.length === 0 || busy} onClick={doSettle}>
                  Settle (on-chain, once)
                </button>
                <button className="danger" disabled={states.length < 2 || busy} onClick={doCheat}>
                  😈 Simulate Bob cheating
                </button>
                <p className="recoverHint">
                  ♻ The funds are locked in the tunnel while it's open — after you <b>settle</b>, a
                  Recover button sweeps all leftover SUI back to the sponsor.
                </p>
              </>
            )}
            {(phase === "funding" || phase === "opening" || phase === "settling" || phase === "cheating") && (
              <button className="primary" disabled>working…</button>
            )}
            {phase === "closed" && (
              <>
                <p className="done">✅ {finalNote}</p>
                {!swept && (
                  <button className="recover" onClick={doRecover}>
                    ♻ Recover leftover SUI to the sponsor
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        <section className="party bob">
          <h3>Bob</h3>
          <p className="addr mono">{short(B)}</p>
          <div className="bal">
            <span className="blab">in-tunnel balance</span>
            <span className="bnum">{tunnelId ? fmt(balB) : "—"}</span>
          </div>
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
        tunnels_edu::channel on testnet · <span className="mono">{short(CONFIG.packageId)}</span> ·{" "}
        <a href="/explain.html">how it works, step by step</a> · SuiHub Lagos ·
        github.com/Nuel-osas/tunneling
      </footer>
    </div>
  );
}
