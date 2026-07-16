// Live testnet deployment of tunnels_edu::channel (see ../move).
// If the package stops resolving, testnet was reset — republish and repaste.
export const CONFIG = {
  network: "testnet" as const,
  rpc: "https://sui-testnet-rpc.publicnode.com",
  packageId: "0x9bd35322a0e12f0339f7af281838e0ae40ce15238c3a75b55cae8e421afc1c4e",
  clock: "0x6",
  fundEndpoint: "/api/fund",
  // demo economics (MIST)
  fundAmount: 100_000_000n, // 0.1 SUI each — deposit 0.05 + gas (~0.003/tx)
  deposit: 50_000_000n, // 0.05 SUI each side
  payStep: 5_000_000n, // one button press moves 0.005
  disputeWindowMs: 30_000, // 30s — visible countdown in the dispute demo
};

export const explorerTx = (d: string) => `https://suiscan.xyz/testnet/tx/${d}`;
export const fmt = (mist: bigint | number) => (Number(mist) / 1e9).toFixed(3);
