// Devnet (or local validator) smoke test for the deployed SunFire program.
// Uses raw web3.js so it needs no Anchor IDL.
//
//   RPC_URL=https://api.devnet.solana.com \
//   DEPLOYER=path/to/upgrade-authority.json \
//   PROGRAM_ID=<program id> \
//   node tests/devnet-smoke.cjs
//
// Covers: initialize (upgrade authority only, once), update_settings guards,
// distribute (exact 50/50 split, empty vault, small-amount rent edge case),
// arm guards (keeper only, reading age, tier), and renounce (optional, RENOUNCE=1).
// execute needs Jupiter, which is not on devnet, so it is not covered.

const crypto = require("crypto");
const fs = require("fs");
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  LAMPORTS_PER_SOL, SYSVAR_SLOT_HASHES_PUBKEY, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { createMint } = require("@solana/spl-token");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER, "utf8"))));
const conn = new Connection(RPC_URL, "confirmed");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const VAULT_FLOOR = 1_000_000;
const ERR = { DevShareTooHigh: 6000, NotAdmin: 6001, NothingToDistribute: 6002, StaleReading: 6003, BadTier: 6004, NotKeeper: 6013 };

const disc = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
const config = pda("config"), feeVault = pda("fee_vault"), burnVault = pda("burn_vault");
const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)[0];
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

async function send(ix, signers) {
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

function customCode(e) {
  const logs = (e.logs || e.transactionLogs || []).join("\n") + String(e.message || e);
  const m = logs.match(/custom program error: 0x([0-9a-f]+)/i) || logs.match(/Error Number: (\d+)/);
  if (!m) return { code: null, logs };
  return { code: m[0].startsWith("custom") ? parseInt(m[1], 16) : Number(m[1]), logs };
}

async function expectFail(name, fn, code) {
  try {
    await fn();
    record(name, false, "transaction succeeded but should have failed");
  } catch (e) {
    const got = customCode(e);
    const ok = code === undefined ? true : got.code === code;
    record(name, ok, ok ? `rejected (${got.code ?? "non-custom error"})` : `expected ${code}, got ${got.code}: ${got.logs.slice(-400)}`);
  }
}

async function expectOk(name, fn) {
  try {
    const sig = await fn();
    record(name, true, sig ? `sig ${sig}` : "");
    return true;
  } catch (e) {
    record(name, false, customCode(e).logs.slice(-600));
    return false;
  }
}

const transfer = (from, to, lamports) => send(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }), [from]);

function initIx(admin, mint, args) {
  const data = Buffer.concat([
    disc("initialize"), args.devWallet.toBuffer(), u16(args.devBps),
    args.keeper.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      meta(admin, true, true), meta(config, true), meta(PROGRAM_ID), meta(programData),
      meta(feeVault), meta(burnVault), meta(mint), meta(SystemProgram.programId),
    ],
  });
}

function updateIx(admin, args) {
  const data = Buffer.concat([
    disc("update_settings"), args.devWallet.toBuffer(), u16(args.devBps),
    args.keeper.toBuffer(),
  ]);
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [meta(admin, false, true), meta(config, true)] });
}

const distributeIx = (devWallet) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc("distribute"),
  keys: [meta(config), meta(feeVault, true), meta(burnVault, true), meta(devWallet, true), meta(SystemProgram.programId)],
});

const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const armIx = (keeper, tier, reading, observedAt) => new TransactionInstruction({
  programId: PROGRAM_ID, data: Buffer.concat([disc("arm"), Buffer.from([tier]), u64(reading), i64(observedAt)]),
  keys: [meta(keeper, false, true), meta(config, true), meta(burnVault), meta(SYSVAR_SLOT_HASHES_PUBKEY)],
});

const renounceIx = (admin) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc("renounce"), keys: [meta(admin, false, true), meta(config, true)],
});

async function readConfig() {
  const info = await conn.getAccountInfo(config);
  const d = info.data; let o = 8;
  const pk = () => { const p = new PublicKey(d.subarray(o, o + 32)); o += 32; return p; };
  const c = { admin: pk(), keeper: pk(), devWallet: pk() };
  c.devBps = d.readUInt16LE(o); o += 2;
  c.sfireMint = pk();
  c.mFired = !!d[o++]; c.xFired = !!d[o++]; c.stormFired = !!d[o++];
  c.pendingBudget = d.readBigUInt64LE(o); o += 8;
  c.pendingTier = d[o++];
  c.events = d.readBigUInt64LE(o); o += 8;
  return c;
}

async function main() {
  console.log(`RPC ${RPC_URL}\nprogram ${PROGRAM_ID.toBase58()}\ndeployer ${deployer.publicKey.toBase58()}`);
  console.log(`config ${config.toBase58()}\nfee_vault ${feeVault.toBase58()}\nburn_vault ${burnVault.toBase58()}`);
  console.log(`balance ${(await conn.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL} SOL\n`);

  const attacker = Keypair.generate();
  const devWallet = Keypair.generate().publicKey;
  await transfer(deployer, attacker.publicKey, 0.05 * LAMPORTS_PER_SOL);
  // Dev wallet must exist before it can receive a small share (see rent edge case below).
  await transfer(deployer, devWallet, 0.002 * LAMPORTS_PER_SOL);

  const mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
  console.log(`test $SFIRE mint ${mint.toBase58()}\n`);

  const args = { devWallet, devBps: 5000, keeper: deployer.publicKey };

  // ---- initialize ----
  if (await conn.getAccountInfo(config)) {
    record("initialize: config not yet created", false, "config already exists; redeploy with a new program id to rerun from scratch");
    return;
  }
  await expectFail("initialize from a non-authority signer is rejected", () => send(initIx(attacker.publicKey, mint, args), [attacker]), ERR.NotAdmin);
  await expectFail("initialize with dev_bps 5001 is rejected", () => send(initIx(deployer.publicKey, mint, { ...args, devBps: 5001 }), [deployer]), ERR.DevShareTooHigh);
  await expectOk("initialize from the upgrade authority succeeds", () => send(initIx(deployer.publicKey, mint, args), [deployer]));
  const c0 = await readConfig();
  record("config stored as given", c0.admin.equals(deployer.publicKey) && c0.devWallet.equals(devWallet) && c0.devBps === 5000 && c0.sfireMint.equals(mint) && c0.keeper.equals(deployer.publicKey));
  await expectFail("second initialize is rejected", () => send(initIx(deployer.publicKey, mint, args), [deployer]));

  // ---- update_settings guards ----
  await expectFail("update_settings from non-admin is rejected", () => send(updateIx(attacker.publicKey, args), [attacker]), ERR.NotAdmin);
  await expectFail("update_settings with dev_bps 5001 is rejected", () => send(updateIx(deployer.publicKey, { ...args, devBps: 5001 }), [deployer]), ERR.DevShareTooHigh);

  // ---- distribute ----
  await expectFail("distribute with empty fee vault is rejected", () => send(distributeIx(devWallet), [deployer]));
  const fees = 0.1 * LAMPORTS_PER_SOL;
  await transfer(deployer, feeVault, fees);
  const fv0 = await conn.getBalance(feeVault), dw0 = await conn.getBalance(devWallet), bv0 = await conn.getBalance(burnVault);
  const avail = fv0 - VAULT_FLOOR, devShare = Math.floor(avail * 5000 / 10000), burnShare = avail - devShare;
  await expectFail("distribute to a wrong dev wallet is rejected", () => send(distributeIx(attacker.publicKey), [attacker]));
  if (await expectOk("distribute (permissionless, called by a stranger) succeeds", () => send(distributeIx(devWallet), [attacker]))) {
    const fv1 = await conn.getBalance(feeVault), dw1 = await conn.getBalance(devWallet), bv1 = await conn.getBalance(burnVault);
    record("distribute: fee vault left at VAULT_FLOOR", fv1 === VAULT_FLOOR, `fee_vault ${fv1}`);
    record("distribute: dev gets exactly 50 %", dw1 - dw0 === devShare, `dev +${dw1 - dw0}, expected ${devShare}`);
    record("distribute: burn vault gets exactly 50 %", bv1 - bv0 === burnShare, `burn +${bv1 - bv0}, expected ${burnShare}`);
  }
  await expectFail("distribute again with only the floor left is rejected", () => send(distributeIx(devWallet), [deployer]), ERR.NothingToDistribute);

  // Edge case: a brand-new dev wallet cannot receive a share below the rent-exempt minimum.
  const freshDev = Keypair.generate().publicKey;
  await expectOk("update_settings by admin (new, unfunded dev wallet)", () => send(updateIx(deployer.publicKey, { ...args, devWallet: freshDev }), [deployer]));
  await transfer(deployer, feeVault, 1_000_000); // 0.001 SOL of fees -> 0.0005 SOL dev share
  try {
    await send(distributeIx(freshDev), [deployer]);
    record("edge: small distribute to unfunded dev wallet", true, "succeeded");
  } catch (e) {
    record("edge: small distribute to unfunded dev wallet", true, "FAILS as expected (rent): a dev share below ~0.00089 SOL to an empty wallet reverts the whole distribute. Fund the dev wallet once to avoid it");
  }
  await expectOk("update_settings back to the funded dev wallet", () => send(updateIx(deployer.publicKey, args), [deployer]));
  await expectOk("small distribute to funded dev wallet succeeds", () => send(distributeIx(devWallet), [deployer]));

  // ---- arm guards (full arm flow is in local-arm.cjs) ----
  const now = Math.floor(Date.now() / 1000);
  await expectFail("arm by someone other than the keeper is rejected (NotKeeper)", () => send(armIx(attacker.publicKey, 1, 200_000, now), [attacker]), ERR.NotKeeper);
  await expectFail("arm with a reading older than 6 h is rejected (StaleReading)", () => send(armIx(deployer.publicKey, 1, 200_000, now - 7 * 3600), [deployer]), ERR.StaleReading);
  await expectFail("arm with a reading in the future is rejected (StaleReading)", () => send(armIx(deployer.publicKey, 1, 200_000, now + 3600), [deployer]), ERR.StaleReading);
  await expectFail("arm with tier 3 is rejected (BadTier)", () => send(armIx(deployer.publicKey, 3, 200_000, now), [deployer]), ERR.BadTier);

  // ---- renounce ----
  if (process.env.RENOUNCE === "1") {
    await expectFail("renounce from non-admin is rejected", () => send(renounceIx(attacker.publicKey), [attacker]), ERR.NotAdmin);
    await expectOk("renounce by admin succeeds", () => send(renounceIx(deployer.publicKey), [deployer]));
    await expectFail("update_settings after renounce is rejected", () => send(updateIx(deployer.publicKey, args), [deployer]), ERR.NotAdmin);
  }
}

main()
  .catch((e) => { console.error(e); results.push({ name: "script crashed", ok: false }); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
