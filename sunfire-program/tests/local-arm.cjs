// Local-validator test of `arm`, `sync` and `disarm` with keeper-reported
// NOAA readings. Run devnet-smoke.cjs first (without RENOUNCE) against the
// same validator: it initializes the config and fills the burn vault.
//
//   RPC_URL=http://127.0.0.1:8899 DEPLOYER=... PROGRAM_ID=... node tests/local-arm.cjs

const crypto = require("crypto");
const fs = require("fs");
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_SLOT_HASHES_PUBKEY, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER, "utf8"))));
const conn = new Connection(RPC_URL, "confirmed");
const ERR = { NoEvent: 6005, AlreadyTriggered: 6006, BurnPending: 6007, NothingArmed: 6008, NotKeeper: 6013 };

// Readings as the keeper reports them: X-ray flux W/m² × 1e9, Kp × 100.
const XRAY = { quiet: 1_000, m2: 20_000, x2: 200_000 };
const KP = { quiet: 300, storm: 833 };
const TIER = { M: 0, X: 1, Storm: 2 };

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
const config = pda("config"), burnVault = pda("burn_vault");
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const now = () => Math.floor(Date.now() / 1000) - 60;

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};
const sendAs = (ix, extra) => sendAndConfirmTransaction(conn, new Transaction().add(ix), [deployer, ...extra], { commitment: "confirmed" });
const send = (ix) => sendAs(ix, []);
const code = (e) => {
  const logs = (e.logs || e.transactionLogs || []).join("\n") + String(e.message);
  const m = logs.match(/Error Number: (\d+)/) || logs.match(/custom program error: 0x([0-9a-f]+)/i);
  return m ? (m[0].startsWith("custom") ? parseInt(m[1], 16) : Number(m[1])) : null;
};

const armIx = (tier, reading, keeper = deployer.publicKey) => new TransactionInstruction({
  programId: PROGRAM_ID, data: Buffer.concat([disc("arm"), Buffer.from([tier]), u64(reading), i64(now())]),
  keys: [meta(keeper, false, true), meta(config, true), meta(burnVault), meta(SYSVAR_SLOT_HASHES_PUBKEY)],
});
const syncIx = (xray, kp, keeper = deployer.publicKey) => new TransactionInstruction({
  programId: PROGRAM_ID, data: Buffer.concat([disc("sync"), u64(xray), u64(kp), i64(now())]),
  keys: [meta(keeper, false, true), meta(config, true)],
});
const disarmIx = (authority) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc("disarm"), keys: [meta(authority, false, true), meta(config, true)],
});

async function readConfig() {
  const d = (await conn.getAccountInfo(config)).data;
  const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  const o = 8 + 32 * 3 + 2 + 32;
  return {
    keeper: pk(40), devWallet: pk(72), devBps: d.readUInt16LE(104),
    mFired: !!d[o], xFired: !!d[o + 1], stormFired: !!d[o + 2],
    pendingBudget: d.readBigUInt64LE(o + 3), pendingTier: d[o + 11], events: d.readBigUInt64LE(o + 12),
  };
}

async function expectTx(name, ix, expected, signers = []) {
  try {
    const sig = await sendAs(ix, signers);
    record(name, expected === undefined, `sig ${sig.slice(0, 20)}...`);
  } catch (e) {
    record(name, expected !== undefined && code(e) === expected, `error ${code(e)}`);
  }
}

const share = (budget, spendable) => `${budget} lamports (${(Number(budget) * 100 / spendable).toFixed(2)} %)`;

async function main() {
  const stranger = Keypair.generate();
  await expectTx("arm M on quiet flux (C-class) is rejected (NoEvent)", armIx(TIER.M, XRAY.quiet), ERR.NoEvent);
  await expectTx("arm Storm at Kp 3 is rejected (NoEvent)", armIx(TIER.Storm, KP.quiet), ERR.NoEvent);
  await expectTx("arm X on an M2.0 reading is rejected (NoEvent)", armIx(TIER.X, XRAY.m2), ERR.NoEvent);
  await expectTx("arm by a stranger is rejected (NotKeeper)", armIx(TIER.M, XRAY.m2, stranger.publicKey), ERR.NotKeeper, [stranger]);

  const spendable = (await conn.getBalance(burnVault)) - 1_000_000;
  await expectTx("arm M on an M2.0 reading succeeds", armIx(TIER.M, XRAY.m2));
  let c = await readConfig();
  record("M budget is 1-5 % of the spendable burn vault",
    c.pendingBudget >= BigInt(Math.floor(spendable * 0.01)) && c.pendingBudget <= BigInt(Math.floor(spendable * 0.05)), share(c.pendingBudget, spendable));
  record("state after arm: m_fired, pending tier M, events 1", c.mFired && !c.xFired && c.pendingTier === 0 && c.events === 1n);
  await expectTx("second arm while a burn is pending is rejected (BurnPending)", armIx(TIER.M, XRAY.m2), ERR.BurnPending);
  await expectTx("arm X while the M burn is pending is rejected (BurnPending)", armIx(TIER.X, XRAY.x2), ERR.BurnPending);

  await expectTx("sync by a stranger is rejected (NotKeeper)", syncIx(XRAY.quiet, KP.quiet, stranger.publicKey), ERR.NotKeeper, [stranger]);
  await send(syncIx(XRAY.m2, KP.quiet));
  c = await readConfig();
  record("sync at M level keeps m_fired set", c.mFired === true);
  await send(syncIx(XRAY.quiet, KP.quiet));
  c = await readConfig();
  record("sync after flux drops below M re-arms (m_fired cleared)", c.mFired === false && c.pendingBudget > 0n,
    `m_fired=${c.mFired}, pending still ${c.pendingBudget}`);

  // ---- disarm ----
  const vaultBefore = await conn.getBalance(burnVault);
  await expectTx("disarm by a stranger is rejected (NotKeeper)", disarmIx(stranger.publicKey), ERR.NotKeeper, [stranger]);
  await send(disarmIx(deployer.publicKey));
  c = await readConfig();
  record("disarm by the keeper clears the pending burn", c.pendingBudget === 0n);
  record("disarm moves no lamports", (await conn.getBalance(burnVault)) === vaultBefore);
  await expectTx("disarm with nothing armed is rejected (NothingArmed)", disarmIx(deployer.publicKey), ERR.NothingArmed);

  await expectTx("after disarm, an X flare arms again", armIx(TIER.X, XRAY.x2));
  c = await readConfig();
  record("X budget is 10-25 %", c.pendingTier === 1 && c.pendingBudget >= BigInt(Math.floor(spendable * 0.10)) && c.pendingBudget <= BigInt(Math.floor(spendable * 0.25)),
    share(c.pendingBudget, spendable));

  // Admin path: hand the keeper role to another key, the admin can still disarm.
  const keeper2 = Keypair.generate().publicKey;
  await send(new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc("update_settings"), c.devWallet.toBuffer(), u16(c.devBps), keeper2.toBuffer()]),
    keys: [meta(deployer.publicKey, false, true), meta(config, true)],
  }));
  await send(disarmIx(deployer.publicKey));
  c = await readConfig();
  record("disarm by the admin (not keeper) works", c.pendingBudget === 0n);
  // Give the keeper role back.
  await send(new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc("update_settings"), c.devWallet.toBuffer(), u16(c.devBps), deployer.publicKey.toBuffer()]),
    keys: [meta(deployer.publicKey, false, true), meta(config, true)],
  }));
  await expectTx("same X flare cannot be armed twice (AlreadyTriggered)", armIx(TIER.X, XRAY.x2), ERR.AlreadyTriggered);
  await expectTx("a G4+ storm (Kp 8.33) arms independently", armIx(TIER.Storm, KP.storm));
  c = await readConfig();
  record("Storm budget is 30-50 %", c.pendingTier === 2 && c.pendingBudget >= BigInt(Math.floor(spendable * 0.30)) && c.pendingBudget <= BigInt(Math.floor(spendable * 0.50)),
    share(c.pendingBudget, spendable));
}

main()
  .catch((e) => { console.error(e); results.push({ ok: false }); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
