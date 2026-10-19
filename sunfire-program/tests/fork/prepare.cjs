// Step 1 of the mainnet-fork test: asks Jupiter for a route paid by the burn
// vault, then lists every mainnet account and program the route touches so
// solana-test-validator can clone them.
//
//   PROGRAM_ID=... MINT=<pump.fun mint> OUT=fork-plan.json node tests/fork/prepare.cjs

const fs = require("fs");
const { Connection, PublicKey } = require("@solana/web3.js");
const { jupiterRoute, WSOL } = require("./jupiter-route.cjs");

const MAINNET = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
const MINT = new PublicKey(process.env.MINT);
const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
// Already in solana-test-validator's genesis.
const BUILTIN = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
]);

async function main() {
  const conn = new Connection(MAINNET, "confirmed");
  const burnVault = PublicKey.findProgramAddressSync([Buffer.from("burn_vault")], PROGRAM_ID)[0];
  const mintInfo = await conn.getAccountInfo(MINT);
  const mintProgram = mintInfo.owner;
  console.log(`mint ${MINT.toBase58()} owned by ${mintProgram.toBase58()}`);
  console.log(`burn vault ${burnVault.toBase58()}`);

  const r = await jupiterRoute({
    burnVault, mint: MINT, mintProgram, lamports: 20_000_000, slippageBps: 500, dexes: process.env.DEXES,
  });
  const labels = r.quote.routePlan.map((p) => p.swapInfo.label);
  console.log(`route: ${labels.join(" -> ")}, out ${r.quote.outAmount}`);
  console.log(`setup instructions: ${JSON.stringify(r.setup)}  other: ${JSON.stringify(r.other)}`);

  const skip = new Set([burnVault, r.vaultWsol, r.vaultToken].map((k) => k.toBase58()));
  const keys = [...new Set([r.ix.programId.toBase58(), MINT.toBase58(), WSOL.toBase58(), ...r.ix.keys.map((k) => k.pubkey.toBase58())])]
    .filter((k) => !BUILTIN.has(k) && !skip.has(k));
  const infos = [];
  for (let i = 0; i < keys.length; i += 100) {
    infos.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100).map((k) => new PublicKey(k))));
  }
  const programs = [], accounts = [], missing = [];
  keys.forEach((k, i) => {
    const a = infos[i];
    if (!a) missing.push(k);
    else if (a.executable && a.owner.toBase58() === LOADER_V3) programs.push(k);
    else if (a.executable) console.log(`  note: ${k} is a non-upgradeable program (owner ${a.owner.toBase58()}), assumed builtin`);
    else accounts.push(k);
  });
  console.log(`clone ${programs.length} programs, ${accounts.length} accounts; ${missing.length} not on mainnet (created during the swap): ${missing.join(" ")}`);
  const plan = {
    mint: MINT.toBase58(), mintProgram: mintProgram.toBase58(), burnVault: burnVault.toBase58(),
    route: labels, programs, accounts, missing,
  };
  fs.writeFileSync(process.env.OUT || "fork-plan.json", JSON.stringify(plan, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
