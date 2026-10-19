// Devnet test of `arm` and `sync` against real Switchboard On-Demand feeds.
// Run after devnet-smoke.cjs without RENOUNCE, on a build made with
// `cargo build-sbf --features devnet` (otherwise every devnet feed is BadFeed).
//
// It creates two feeds with constant jobs, so the result does not depend on
// the Sun: xray = 2e-5 W/m² (an M2.0 flare) and Kp = 3 (quiet). It then points
// the config at them with update_settings and sends each `arm` in the same
// transaction as a fresh oracle update, as the program requires.
//
//   RPC_URL=https://api.devnet.solana.com DEPLOYER=... PROGRAM_ID=... node tests/devnet-arm.cjs

const crypto = require("crypto");
const fs = require("fs");
const {
  Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, SYSVAR_SLOT_HASHES_PUBKEY,
} = require("@solana/web3.js");
const sb = require("@switchboard-xyz/on-demand");
const { OracleJob } = require("@switchboard-xyz/common");

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER, "utf8"))));
const conn = new Connection(RPC_URL, "confirmed");
const ERR = { BadFeed: 6003, StaleFeed: 6004, NoEvent: 6006, AlreadyTriggered: 6007, BurnPending: 6008 };

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
const config = pda("config"), burnVault = pda("burn_vault");
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};

const armIx = (tier, xray, kp) => new TransactionInstruction({
  programId: PROGRAM_ID, data: Buffer.concat([disc("arm"), Buffer.from([tier])]),
  keys: [meta(config, true), meta(burnVault), meta(xray), meta(kp), meta(SYSVAR_SLOT_HASHES_PUBKEY)],
});
const syncIx = (xray, kp) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc("sync"), keys: [meta(config, true), meta(xray), meta(kp)],
});

async function readConfig() {
  const d = (await conn.getAccountInfo(config)).data;
  const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  const o = 8 + 32 * 3 + 2 + 32 * 3;
  return {
    admin: pk(8), keeper: pk(40), devWallet: pk(72), devBps: d.readUInt16LE(104),
    mFired: !!d[o], xFired: !!d[o + 1], stormFired: !!d[o + 2],
    pendingBudget: d.readBigUInt64LE(o + 3), pendingTier: d[o + 11], events: d.readBigUInt64LE(o + 12),
  };
}

async function sendV0(ixs, luts = []) {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: deployer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ...ixs],
  }).compileToV0Message(luts);
  const tx = new VersionedTransaction(msg);
  tx.sign([deployer]);
  const sim = await conn.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join("\n");
    const m = logs.match(/Error Number: (\d+)/) || logs.match(/custom program error: 0x([0-9a-f]+)/i);
    const code = m ? (m[0].startsWith("custom") ? parseInt(m[1], 16) : Number(m[1])) : null;
    const e = new Error(`simulation failed (${code}): ${logs.slice(-700)}`); e.code = code; throw e;
  }
  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  const bh = await conn.getLatestBlockhash();
  const r = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (r.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}

async function createFeed(program, queue, name, value) {
  const jobs = [OracleJob.fromObject({ tasks: [{ valueTask: { value } }] })];
  // The init instruction embeds a recent slot for its lookup table, which RPC
  // preflight often has not seen yet: skip preflight and retry on failure.
  for (let attempt = 1; ; attempt++) {
    const [feed, feedKp] = sb.PullFeed.generate(program);
    const ix = await feed.initIx({
      name, queue: queue.pubkey, maxVariance: 1, minResponses: 1, minSampleSize: 1, maxStaleness: 150,
      jobs, payer: deployer.publicKey,
    });
    const bh = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: deployer.publicKey, recentBlockhash: bh.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([deployer, feedKp]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: true });
    const r = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (!r.value.err) return { feed, jobs };
    if (attempt >= 4) throw new Error(`feed init failed: ${sig} ${JSON.stringify(r.value.err)}`);
    await new Promise((s) => setTimeout(s, 2000));
  }
}

async function updateIxs(f) {
  const [ixs, responses, ok, luts, logs] = await f.feed.fetchUpdateIx({ numSignatures: 1, jobs: f.jobs, payer: deployer.publicKey });
  if (!ixs) throw new Error(`oracle update failed: ${JSON.stringify(responses).slice(0, 400)} ${logs}`);
  return { ixs, luts };
}

async function tryArm(name, tier, feeds, expectCode) {
  try {
    const ups = await Promise.all(feeds.map(updateIxs));
    const sig = await sendV0([...ups.flatMap((u) => u.ixs), armIx(tier, feeds[0].feed.pubkey, feeds[1].feed.pubkey)], ups.flatMap((u) => u.luts));
    record(name, expectCode === undefined, `sig ${sig}`);
  } catch (e) {
    record(name, expectCode !== undefined && e.code === expectCode, `${e.code ?? ""} ${String(e.message).slice(0, 700)}`);
  }
}

async function main() {
  const queue = await sb.getDefaultDevnetQueue(RPC_URL);
  const program = queue.program;
  console.log(`Switchboard program ${program.programId.toBase58()}, queue ${queue.pubkey.toBase58()}`);

  const xray = await createFeed(program, queue, "sunfire-test xray M2", 0.00002);
  const kp = await createFeed(program, queue, "sunfire-test kp 3", 3);
  console.log(`xray feed ${xray.feed.pubkey.toBase58()}\nkp feed ${kp.feed.pubkey.toBase58()}`);
  record("feeds owned by the devnet Switchboard program",
    (await conn.getAccountInfo(xray.feed.pubkey)).owner.equals(sb.ON_DEMAND_DEVNET_PID));

  const c = await readConfig();
  const upd = new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc("update_settings"), c.devWallet.toBuffer(), u16(c.devBps), xray.feed.pubkey.toBuffer(), kp.feed.pubkey.toBuffer(), c.keeper.toBuffer()]),
    keys: [meta(deployer.publicKey, false, true), meta(config, true)],
  });
  record("update_settings to the Switchboard feeds", !!(await sendV0([upd])));

  // Stale: without an update in the same tx the feed has no fresh sample.
  try {
    await sendV0([armIx(0, xray.feed.pubkey, kp.feed.pubkey)]);
    record("arm without a fresh update is rejected (StaleFeed)", false, "succeeded");
  } catch (e) { record("arm without a fresh update is rejected (StaleFeed)", e.code === ERR.StaleFeed, `${e.code}`); }

  const feeds = [xray, kp];
  await tryArm("arm Storm with Kp 3 is rejected (NoEvent)", 2, feeds, ERR.NoEvent);
  await tryArm("arm X with an M2 reading is rejected (NoEvent)", 1, feeds, ERR.NoEvent);
  const before = await conn.getBalance(burnVault);
  await tryArm("arm M with an M2 reading succeeds", 0, feeds);
  const after = await readConfig();
  const spendable = before - 1_000_000;
  const okBudget = after.pendingBudget > 0n && after.pendingBudget >= BigInt(Math.floor(spendable * 0.01)) && after.pendingBudget <= BigInt(Math.ceil(spendable * 0.05));
  record("pending_budget is 1-5 % of the burn vault", okBudget, `budget ${after.pendingBudget} of ${spendable} spendable, m_fired=${after.mFired}, events=${after.events}`);
  await tryArm("second arm while a burn is pending is rejected (BurnPending)", 0, feeds, ERR.BurnPending);

  // sync with M-level flux must not re-arm m_fired.
  try {
    const ups = await Promise.all(feeds.map(updateIxs));
    await sendV0([...ups.flatMap((u) => u.ixs), syncIx(xray.feed.pubkey, kp.feed.pubkey)], ups.flatMap((u) => u.luts));
    const s = await readConfig();
    record("sync at M level keeps m_fired set", s.mFired === true);
  } catch (e) { record("sync at M level keeps m_fired set", false, String(e.message).slice(0, 500)); }
}

main()
  .catch((e) => { console.error(e); results.push({ ok: false }); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
