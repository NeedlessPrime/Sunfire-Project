// Local-validator test of `arm` and `sync` with handcrafted Switchboard feed
// accounts (owned by the devnet Switchboard program, one fresh submission).
// Needed because the devnet Switchboard oracles are offline, so a real feed
// update cannot be produced there.
//
// Run devnet-smoke.cjs first (without RENOUNCE) against the same validator.
//   RPC_URL=http://127.0.0.1:8899 DEPLOYER=... PROGRAM_ID=... FEEDS=feeds-index.json node tests/local-arm.cjs

const crypto = require("crypto");
const fs = require("fs");
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_SLOT_HASHES_PUBKEY, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER, "utf8"))));
const feeds = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(process.env.FEEDS, "utf8"))).map(([k, v]) => [k, new PublicKey(v)]));
const conn = new Connection(RPC_URL, "confirmed");
const ERR = { NoEvent: 6006, AlreadyTriggered: 6007, BurnPending: 6008, NothingArmed: 6009, NotKeeper: 6015 };

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
const sendAs = (ix, extra) => sendAndConfirmTransaction(conn, new Transaction().add(ix), [deployer, ...extra], { commitment: "confirmed" });
const send = (ix) => sendAs(ix, []);
const disarmIx = (authority) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc("disarm"), keys: [meta(authority, false, true), meta(config, true)],
});
const code = (e) => {
  const logs = (e.logs || e.transactionLogs || []).join("\n") + String(e.message);
  const m = logs.match(/Error Number: (\d+)/) || logs.match(/custom program error: 0x([0-9a-f]+)/i);
  return m ? (m[0].startsWith("custom") ? parseInt(m[1], 16) : Number(m[1])) : null;
};

async function readConfig() {
  const d = (await conn.getAccountInfo(config)).data;
  const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  const o = 8 + 32 * 3 + 2 + 32 * 3;
  return {
    keeper: pk(40), devWallet: pk(72), devBps: d.readUInt16LE(104),
    mFired: !!d[o], xFired: !!d[o + 1], stormFired: !!d[o + 2],
    pendingBudget: d.readBigUInt64LE(o + 3), pendingTier: d[o + 11], events: d.readBigUInt64LE(o + 12),
  };
}

async function useFeeds(xray, kp) {
  const c = await readConfig();
  await send(new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc("update_settings"), c.devWallet.toBuffer(), u16(c.devBps), feeds[xray].toBuffer(), feeds[kp].toBuffer(), c.keeper.toBuffer()]),
    keys: [meta(deployer.publicKey, false, true), meta(config, true)],
  }));
  return [feeds[xray], feeds[kp]];
}

const armIx = (tier, [xray, kp]) => new TransactionInstruction({
  programId: PROGRAM_ID, data: Buffer.concat([disc("arm"), Buffer.from([tier])]),
  keys: [meta(config, true), meta(burnVault), meta(xray), meta(kp), meta(SYSVAR_SLOT_HASHES_PUBKEY)],
});
const syncIx = ([xray, kp]) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc("sync"), keys: [meta(config, true), meta(xray), meta(kp)],
});

async function expectArm(name, tier, f, expected) {
  try {
    const sig = await send(armIx(tier, f));
    record(name, expected === undefined, `sig ${sig.slice(0, 20)}...`);
  } catch (e) {
    record(name, expected !== undefined && code(e) === expected, `error ${code(e)}`);
  }
}

async function main() {
  let f = await useFeeds("xray_quiet", "kp_quiet");
  await expectArm("arm M with quiet flux (C-class) is rejected (NoEvent)", 0, f, ERR.NoEvent);
  await expectArm("arm Storm with Kp 3 is rejected (NoEvent)", 2, f, ERR.NoEvent);

  f = await useFeeds("xray_m2", "kp_quiet");
  await expectArm("arm X with an M2.0 reading is rejected (NoEvent)", 1, f, ERR.NoEvent);
  const spendable = (await conn.getBalance(burnVault)) - 1_000_000;
  await expectArm("arm M with an M2.0 reading succeeds", 0, f);
  let c = await readConfig();
  const lo = Math.floor(spendable * 0.01), hi = Math.floor(spendable * 0.05);
  record("budget is 1-5 % of the spendable burn vault", c.pendingBudget >= BigInt(lo) && c.pendingBudget <= BigInt(hi),
    `budget ${c.pendingBudget} lamports (${(Number(c.pendingBudget) * 100 / spendable).toFixed(2)} %) of ${spendable}`);
  record("state after arm: m_fired, pending tier M, events 1", c.mFired && !c.xFired && c.pendingTier === 0 && c.events === 1n);
  await expectArm("second arm while a burn is pending is rejected (BurnPending)", 0, f, ERR.BurnPending);

  f = await useFeeds("xray_x2", "kp_storm");
  await expectArm("arm X while M burn is pending is rejected (BurnPending)", 1, f, ERR.BurnPending);

  f = await useFeeds("xray_m2", "kp_quiet");
  await send(syncIx(f));
  c = await readConfig();
  record("sync at M level keeps m_fired set", c.mFired === true);

  f = await useFeeds("xray_quiet", "kp_quiet");
  await send(syncIx(f));
  c = await readConfig();
  record("sync after flux drops below M re-arms (m_fired cleared)", c.mFired === false && c.pendingBudget > 0n,
    `m_fired=${c.mFired}, pending still ${c.pendingBudget}`);

  // ---- disarm ----
  const stranger = Keypair.generate();
  const vaultBefore = await conn.getBalance(burnVault);
  try {
    await sendAs(disarmIx(stranger.publicKey), [stranger]);
    record("disarm by a stranger is rejected (NotKeeper)", false, "succeeded");
  } catch (e) { record("disarm by a stranger is rejected (NotKeeper)", code(e) === ERR.NotKeeper, `error ${code(e)}`); }
  await send(disarmIx(deployer.publicKey));
  c = await readConfig();
  record("disarm by the keeper clears the pending burn", c.pendingBudget === 0n);
  record("disarm moves no lamports", (await conn.getBalance(burnVault)) === vaultBefore);
  try {
    await send(disarmIx(deployer.publicKey));
    record("disarm with nothing armed is rejected (NothingArmed)", false, "succeeded");
  } catch (e) { record("disarm with nothing armed is rejected (NothingArmed)", code(e) === ERR.NothingArmed, `error ${code(e)}`); }

  f = await useFeeds("xray_x2", "kp_storm");
  await expectArm("after disarm, an X flare arms again", 1, f);
  c = await readConfig();
  record("X budget is 10-25 %", c.pendingTier === 1 && c.pendingBudget >= BigInt(Math.floor(spendable * 0.10)) && c.pendingBudget <= BigInt(Math.floor(spendable * 0.25)),
    `budget ${c.pendingBudget} (${(Number(c.pendingBudget) * 100 / spendable).toFixed(2)} %)`);

  // Admin path: hand the keeper role to another key, admin can still disarm.
  const keeper2 = Keypair.generate().publicKey;
  const cfg = await readConfig();
  await send(new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc("update_settings"), cfg.devWallet.toBuffer(), u16(cfg.devBps), feeds.xray_x2.toBuffer(), feeds.kp_storm.toBuffer(), keeper2.toBuffer()]),
    keys: [meta(deployer.publicKey, false, true), meta(config, true)],
  }));
  await send(disarmIx(deployer.publicKey));
  c = await readConfig();
  record("disarm by the admin (not keeper) works", c.pendingBudget === 0n);
  await expectArm("same X flare cannot be armed twice (AlreadyTriggered)", 1, f, ERR.AlreadyTriggered);
  await expectArm("a G4+ storm arms independently", 2, f);
  c = await readConfig();
  record("Storm budget is 30-50 %", c.pendingTier === 2 && c.pendingBudget >= BigInt(Math.floor(spendable * 0.30)) && c.pendingBudget <= BigInt(Math.floor(spendable * 0.50)),
    `budget ${c.pendingBudget} (${(Number(c.pendingBudget) * 100 / spendable).toFixed(2)} %)`);
}

main()
  .catch((e) => { console.error(e); results.push({ ok: false }); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
