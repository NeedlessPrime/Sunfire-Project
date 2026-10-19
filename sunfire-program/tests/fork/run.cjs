// Step 2 of the mainnet-fork test, against a solana-test-validator started
// with the accounts listed by prepare.cjs, the program built without the
// devnet feature, and handcrafted feeds owned by Switchboard's mainnet program.
//
// Runs the real flow on a real pump.fun token with zero real SOL:
// initialize -> distribute -> arm -> Jupiter route for the armed budget -> execute,
// then checks the bought tokens were burned and the vault paid exactly the swap.
//
//   RPC_URL=http://127.0.0.1:8899 PROGRAM_ID=... DEPLOYER=... MINT=... FEEDS=feeds-index.json \
//   node tests/fork/run.cjs

const crypto = require("crypto");
const fs = require("fs");
const {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Transaction, TransactionInstruction, TransactionMessage,
  VersionedTransaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const { jupiterRoute, WSOL } = require("./jupiter-route.cjs");

const conn = new Connection(process.env.RPC_URL || "http://127.0.0.1:8899", "confirmed");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
const MINT = new PublicKey(process.env.MINT);
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER, "utf8"))));
const feeds = JSON.parse(fs.readFileSync(process.env.FEEDS, "utf8"));

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
const config = pda("config"), feeVault = pda("fee_vault"), burnVault = pda("burn_vault");
const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)[0];
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const send = (ixs, extra = []) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [deployer, ...extra], { commitment: "confirmed" });

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};

async function readConfig() {
  const d = (await conn.getAccountInfo(config)).data;
  const o = 8 + 32 * 3 + 2 + 32 * 3;
  return {
    mFired: !!d[o], pendingBudget: d.readBigUInt64LE(o + 3), events: d.readBigUInt64LE(o + 12),
    totalBurned: d.readBigUInt64LE(o + 20), totalSolSpent: d.readBigUInt64LE(o + 28),
  };
}
const tokenAmount = async (acc) => BigInt((await conn.getTokenAccountBalance(acc)).value.amount);
const mintSupply = async () => BigInt((await conn.getTokenSupply(MINT)).value.amount);

async function sendV0(ixs, lut) {
  const bh = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: deployer.publicKey, recentBlockhash: bh.blockhash, instructions: ixs })
    .compileToV0Message(lut ? [lut] : []);
  const tx = new VersionedTransaction(msg);
  tx.sign([deployer]);
  console.log(`  v0 tx size ${tx.serialize().length} bytes`);
  const sim = await conn.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) {
    const e = new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
    e.logs = sim.value.logs; throw e;
  }
  console.log(`  compute units used: ${sim.value.unitsConsumed}`);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const r = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (r.value.err) throw new Error(`tx failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}

async function makeLut(addresses) {
  const slot = await conn.getSlot("finalized");
  const [create, lut] = AddressLookupTableProgram.createLookupTable({ authority: deployer.publicKey, payer: deployer.publicKey, recentSlot: slot });
  await send([create]);
  for (let i = 0; i < addresses.length; i += 25) {
    await send([AddressLookupTableProgram.extendLookupTable({ lookupTable: lut, authority: deployer.publicKey, payer: deployer.publicKey, addresses: addresses.slice(i, i + 25) })]);
  }
  const start = await conn.getSlot();
  while ((await conn.getSlot()) < start + 2) await new Promise((r) => setTimeout(r, 400));
  return (await conn.getAddressLookupTable(lut)).value;
}

async function main() {
  const mintInfo = await conn.getAccountInfo(MINT);
  if (!mintInfo) throw new Error("mint not cloned into the validator");
  const mintProgram = mintInfo.owner;
  console.log(`token ${MINT.toBase58()} (${mintProgram.equals(TOKEN_PROGRAM_ID) ? "SPL Token" : "Token-2022"})`);

  // ---- initialize with the real pump.fun mint ----
  const devWallet = Keypair.generate().publicKey;
  await send([SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: devWallet, lamports: 0.01 * LAMPORTS_PER_SOL })]);
  try {
    await send([new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([disc("initialize"), devWallet.toBuffer(), u16(5000), new PublicKey(feeds.xray_m2).toBuffer(), new PublicKey(feeds.kp_quiet).toBuffer(), deployer.publicKey.toBuffer()]),
      keys: [meta(deployer.publicKey, true, true), meta(config, true), meta(PROGRAM_ID), meta(programData), meta(feeVault), meta(burnVault), meta(MINT), meta(SystemProgram.programId)],
    })]);
    record("initialize accepts a Token-2022 pump.fun mint", true);
  } catch (e) { record("initialize accepts a Token-2022 pump.fun mint", false, (e.logs || []).slice(-3).join(" | ")); throw e; }

  // ---- fees in, distribute ----
  await send([SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: feeVault, lamports: 2 * LAMPORTS_PER_SOL })]);
  await send([new TransactionInstruction({
    programId: PROGRAM_ID, data: disc("distribute"),
    keys: [meta(config), meta(feeVault, true), meta(burnVault, true), meta(devWallet, true), meta(SystemProgram.programId)],
  })]);
  console.log(`burn vault holds ${(await conn.getBalance(burnVault)) / LAMPORTS_PER_SOL} SOL`);

  // ---- vault token accounts (paid by the deployer, owned by the burn vault) ----
  const route0 = { vaultWsol: null, vaultToken: null };
  const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
  route0.vaultWsol = getAssociatedTokenAddressSync(WSOL, burnVault, true, TOKEN_PROGRAM_ID);
  route0.vaultToken = getAssociatedTokenAddressSync(MINT, burnVault, true, mintProgram);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, route0.vaultWsol, burnVault, WSOL, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, route0.vaultToken, burnVault, MINT, mintProgram),
  ]);

  // ---- pump.fun per-user accounts, paid by the keeper ----
  // The pump.fun curve and PumpSwap create a volume accumulator for each buyer
  // on its first buy and charge the rent to the buyer. The program refuses any
  // SOL leaving the vault during the swap, so the keeper creates them first.
  for (const id of ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"]) {
    const pump = new PublicKey(id);
    if (!(await conn.getAccountInfo(pump))) continue; // not cloned for this route
    const uva = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), burnVault.toBuffer()], pump)[0];
    if (await conn.getAccountInfo(uva)) continue;
    const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], pump)[0];
    await send([new TransactionInstruction({
      programId: pump, data: Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]),
      keys: [meta(deployer.publicKey, true, true), meta(burnVault), meta(uva, true), meta(SystemProgram.programId), meta(eventAuthority), meta(pump)],
    })]);
    console.log(`created volume accumulator ${uva.toBase58()} on ${id.slice(0, 4)}... for the burn vault`);
  }

  // ---- arm on an M2 flare ----
  await send([new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.concat([disc("arm"), Buffer.from([0])]),
    keys: [meta(config, true), meta(burnVault), meta(new PublicKey(feeds.xray_m2)), meta(new PublicKey(feeds.kp_quiet)), meta(SYSVAR_SLOT_HASHES_PUBKEY)],
  })]);
  const armed = await readConfig();
  record("arm sets a budget", armed.pendingBudget > 0n, `${Number(armed.pendingBudget) / LAMPORTS_PER_SOL} SOL`);

  // ---- route for the budget, as the keeper bot will do ----
  // The pump.fun curve charges its fees in native SOL on top of the swap
  // amount, and the program counts both against the budget: swap 95 % of it.
  const swapAmount = armed.pendingBudget * 9500n / 10000n;
  const r = await jupiterRoute({
    burnVault, mint: MINT, mintProgram, lamports: swapAmount, slippageBps: 1000, dexes: process.env.DEXES,
  });
  console.log(`route ${r.quote.routePlan.map((p) => p.swapInfo.label).join(" -> ")}: quote ${r.quote.outAmount}, min ${r.quote.otherAmountThreshold}`);
  const routeKeys = r.ix.keys.map((k) => k.pubkey);
  const local = await conn.getMultipleAccountsInfo(routeKeys);
  const absent = routeKeys.filter((k, i) => !local[i]).map((k) => k.toBase58());
  if (absent.length) console.log(`  route accounts absent locally (must be created by the swap): ${absent.join(" ")}`);

  // ---- execute ----
  const supplyBefore = await mintSupply();
  // Vault value = native SOL + its wSOL account.
  const vaultValue = async () => BigInt(await conn.getBalance(burnVault)) + await tokenAmount(route0.vaultWsol);
  const vaultBefore = await vaultValue();
  const minOut = BigInt(r.quote.otherAmountThreshold);
  const execIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc("execute"), u32(r.ix.data.length), r.ix.data, u64(minOut)]),
    keys: [
      meta(deployer.publicKey, false, true), meta(config, true), meta(burnVault, true),
      meta(route0.vaultWsol, true), meta(route0.vaultToken, true), meta(MINT, true), meta(WSOL),
      meta(JUPITER), meta(TOKEN_PROGRAM_ID), meta(mintProgram), meta(SystemProgram.programId),
      ...r.ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable })),
    ],
  });
  const lut = await makeLut([...new Set(execIx.keys.filter((k) => !k.isSigner).map((k) => k.pubkey.toBase58()))].map((k) => new PublicKey(k)));
  try {
    const sig = await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), execIx], lut);
    record("execute: Jupiter swap + burn succeeds", true, `sig ${sig.slice(0, 24)}...`);
  } catch (e) {
    record("execute: Jupiter swap + burn succeeds", false, `${e.message}\n    ${(e.logs || []).slice(process.env.FULL_LOGS ? 0 : -15).join("\n    ")}`);
    return;
  }

  const after = await readConfig();
  const supplyAfter = await mintSupply();
  const vaultAfter = await vaultValue();
  record("bought tokens were burned (supply went down)", supplyAfter < supplyBefore, `burned ${supplyBefore - supplyAfter}, total_burned ${after.totalBurned}`);
  record("burned amount matches config.total_burned", supplyBefore - supplyAfter === after.totalBurned);
  record("burned at least the quoted minimum", after.totalBurned >= minOut, `min_out ${minOut}`);
  record("vault token account is empty after burn", (await tokenAmount(route0.vaultToken)) === 0n);
  record("pending budget cleared", after.pendingBudget === 0n);
  record("vault paid at most the armed budget, and exactly sol_spent", vaultBefore - vaultAfter <= armed.pendingBudget && vaultBefore - vaultAfter === after.totalSolSpent,
    `vault value -${vaultBefore - vaultAfter} lamports, sol_spent ${after.totalSolSpent}, budget ${armed.pendingBudget}`);
}

main()
  .catch((e) => { console.error(e.message || e, (e.logs || []).slice(-10)); results.push({ ok: false }); })
  .finally(() => {
    const failed = results.filter((x) => !x.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
