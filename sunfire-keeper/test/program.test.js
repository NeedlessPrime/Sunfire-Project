import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ata, buildIx, CONFIG_FIELDS, decodeConfig, discriminator, knownAccounts, pdas, pumpVolumeAccumulators, TOKEN_PROGRAM } from "../src/program.js";

const programId = new PublicKey("5mSUozcjURKYk6f3jmd8yuibZfxcyDg8i7TzdFNPk8ae");

test("discriminators follow Anchor's sha256 scheme", () => {
  const expected = createHash("sha256").update("global:disarm").digest().subarray(0, 8);
  assert.deepEqual(discriminator("global", "disarm"), expected);
});

test("PDAs use the program seeds", () => {
  const p = pdas(programId);
  assert.ok(p.config.equals(PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0]));
  assert.ok(p.burnVault.equals(PublicKey.findProgramAddressSync([Buffer.from("burn_vault")], programId)[0]));
  assert.ok(!p.config.equals(p.feeVault));
});

test("arm encodes tier, reading and time after the discriminator", () => {
  const keeper = Keypair.generate().publicKey;
  const ix = buildIx(programId, "arm", knownAccounts(programId, null, keeper), { tier: 1, reading: 150_000, observed_at: 1_760_000_000 });
  assert.deepEqual(ix.data.subarray(0, 8), discriminator("global", "arm"));
  assert.equal(ix.data.readUInt8(8), 1);
  assert.equal(ix.data.readBigUInt64LE(9), 150_000n);
  assert.equal(ix.data.readBigInt64LE(17), 1_760_000_000n);
  assert.equal(ix.data.length, 25);
  assert.ok(ix.keys[0].pubkey.equals(keeper) && ix.keys[0].isSigner);
  assert.ok(ix.keys[1].isWritable, "config is writable");
});

test("execute appends the route accounts after the fixed ones", () => {
  const signer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const extra = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true };
  const a = { ...knownAccounts(programId, { sfireMint: mint }, signer), vault_wsol: signer, vault_sfire: signer, sfire_token_program: TOKEN_PROGRAM };
  const ix = buildIx(programId, "execute", a, { jupiter_data: Buffer.from([7, 8, 9]), min_out: 42n }, [extra]);
  assert.equal(ix.data.readUInt32LE(8), 3);
  assert.deepEqual([...ix.data.subarray(12, 15)], [7, 8, 9]);
  assert.equal(ix.data.readBigUInt64LE(15), 42n);
  assert.equal(ix.keys.at(-1), extra);
});

test("missing accounts or args are refused", () => {
  assert.throws(() => buildIx(programId, "distribute", knownAccounts(programId, null, PublicKey.default)), /missing account dev_wallet/);
  assert.throws(() => buildIx(programId, "arm", knownAccounts(programId, null, PublicKey.default), { tier: 0 }), /Missing argument arm.reading/);
});

test("config decoding round-trips", () => {
  const keys = Object.fromEntries(CONFIG_FIELDS.filter(([, t]) => t === "pubkey").map(([n]) => [n, Keypair.generate().publicKey]));
  const values = { dev_bps: 5000, m_fired: true, x_fired: false, storm_fired: true, pending_budget: 123_456_789n, pending_tier: 2, events: 7n, total_burned: 10n, total_sol_spent: 11n, bump: 255, fee_vault_bump: 254, burn_vault_bump: 253 };
  const parts = [discriminator("account", "Config")];
  for (const [name, type] of CONFIG_FIELDS) {
    const v = keys[name] ?? values[name];
    if (type === "pubkey") parts.push(v.toBuffer());
    else if (type === "u64") { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); parts.push(b); }
    else if (type === "u16") { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); }
    else parts.push(Buffer.from([Number(v)]));
  }
  const c = decodeConfig(Buffer.concat(parts));
  assert.ok(c.keeper.equals(keys.keeper));
  assert.ok(c.sfireMint.equals(keys.sfire_mint));
  assert.equal(c.pendingBudget, 123_456_789n);
  assert.equal(c.pendingTier, 2);
  assert.equal(c.mFired, true);
  assert.equal(c.stormFired, true);
  assert.throws(() => decodeConfig(Buffer.alloc(200)), /Not a SunFire config/);
});

test("ATA derivation matches the known wSOL ATA scheme", () => {
  const owner = new PublicKey("DwZC3fK7z9XNHnatcwVGqWig2SozcS1FBQxhkLZAmLsV");
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const a = ata(owner, mint);
  assert.ok(PublicKey.isOnCurve(owner.toBuffer()));
  assert.ok(!PublicKey.isOnCurve(a.toBuffer()), "ATAs are off-curve PDAs");
  // Same address @solana/spl-token's getAssociatedTokenAddressSync returns.
  assert.equal(a.toBase58(), "FXzMi1gmhES7KR2muXwwmQWYadR52JgfK4vNzavWkTLK");
});

test("pump.fun volume accumulator init matches the pump.fun IDL", () => {
  const payer = new PublicKey("DwZC3fK7z9XNHnatcwVGqWig2SozcS1FBQxhkLZAmLsV");
  const vault = new PublicKey("FGpLMp4v6jiYbemuq4wbbisDzksi9YQoTNeLMVS4XLFx");
  const [curve, amm] = pumpVolumeAccumulators(payer, vault);
  // Discriminator of init_user_volume_accumulator in both pump.fun IDLs.
  assert.deepEqual([...curve.ix.data], [94, 6, 202, 115, 255, 96, 232, 183]);
  assert.deepEqual([...amm.ix.data], [94, 6, 202, 115, 255, 96, 232, 183]);
  // Addresses the programs created for this vault on a mainnet fork.
  assert.equal(curve.address.toBase58(), "DTWnZUgc98sRVKRu8RCihcP2X1KW5SwAdZ3x97sPxt9t");
  assert.equal(amm.address.toBase58(), "BRXCzEQK98t42kXJvrGH5ZExNBPjUA27yoiSs2vigxho");
  assert.ok(curve.ix.keys[0].isSigner && !curve.ix.keys[1].isSigner, "keeper pays, vault does not sign");
});
