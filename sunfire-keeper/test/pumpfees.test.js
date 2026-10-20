import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodeSharingConfig, distributeIx, feeAccounts, PUMP, PUMP_AMM, sweepCreatorFeeIx, sweepPoolCreatorFeeIx, transferAmmFeesIx, waitingCreatorFee, waitingPoolCreatorFee } from "../src/pumpfees.js";

// A real pump.fun token with 50/50 fee sharing, checked on mainnet: simulating
// distributeIx below moved its 0.162 SOL of fees to the two shareholders.
const MINT = new PublicKey("Eowpa4SXEkjsMawvqKwWwayrt3rRS8aJpeThV4dDpump");

test("fee accounts match the ones pump.fun uses on mainnet", () => {
  const a = feeAccounts(MINT);
  assert.equal(a.sharingConfig.toBase58(), "1r6rQT5TmVgPejsGSPSeULSobcR6vZkdVCJPdhWR8Mf");
  assert.equal(a.creatorVault.toBase58(), "BJnY16DLEZ4ctNmdmT2NjoinGrvWedz4FhAX8SjwJ5Hf");
});

test("sharing config decoding", () => {
  const holders = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const buf = Buffer.alloc(80 + 2 * 34);
  MINT.toBuffer().copy(buf, 11);
  buf.writeUInt32LE(2, 76);
  holders.forEach((h, i) => { h.toBuffer().copy(buf, 80 + i * 34); buf.writeUInt16LE(5000, 112 + i * 34); });
  const sc = decodeSharingConfig(buf);
  assert.ok(sc.mint.equals(MINT));
  assert.deepEqual(sc.shareholders.map((s) => [s.address.toBase58(), s.shareBps]), holders.map((h) => [h.toBase58(), 5000]));
});

test("distribute pays every shareholder, signed by nobody", () => {
  const holders = [{ address: Keypair.generate().publicKey, shareBps: 5000 }, { address: Keypair.generate().publicKey, shareBps: 5000 }];
  const ix = distributeIx(MINT, holders);
  assert.ok(ix.programId.equals(PUMP));
  assert.deepEqual([...ix.data], [165, 114, 103, 0, 121, 206, 247, 81]);
  assert.equal(ix.keys.length, 7 + 2);
  assert.ok(ix.keys.every((k) => !k.isSigner));
  assert.ok(ix.keys.slice(7).every((k, i) => k.isWritable && k.pubkey.equals(holders[i].address)));
  assert.ok(ix.keys[3].isWritable && ix.keys[3].pubkey.equals(feeAccounts(MINT).creatorVault));
});

test("the creator fee sweep matches a real mainnet sweep_creator_fee", () => {
  // Accounts of the sweep in 5fXySxkTA4wkd37oB3CZgWPpcwcCptuTF6AMAtd3j8u7NCaxa28yGLzvVCguPsM1Ki9zkpWJAq45ueVbyq5bMq7e,
  // a 100 % shareholder sweeping and distributing its own fees.
  const mint = new PublicKey("9UXiG1vZd4UbYgoLJudxwngVtaKudJiC2YFhicyWpump");
  const payer = new PublicKey("2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y");
  const ix = sweepCreatorFeeIx(mint, payer);
  assert.ok(ix.programId.equals(PUMP));
  assert.deepEqual([...ix.data], [32, 246, 191, 52, 8, 201, 73, 186]);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [
    "2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y", "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", "9UXiG1vZd4UbYgoLJudxwngVtaKudJiC2YFhicyWpump",
    "So11111111111111111111111111111111111111112", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "11111111111111111111111111111111", "8obem6vGwn735qFqSoAouM7gWPYnjH1QckAzcyRdNbLN", "DXo8nJ5qc3AiT9SBMNfTb4mqnjkdQ1QWucahSmfhHKSs",
    "7mtTNb8jEmYt6QqjEaDT3Lh5CdgtwKoaEstEaRiEmEVN", "HgFPrdfboFEASpRNiGvyUtk4fgfQXb173LvDdzKiGj1x", "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  ]);
  assert.deepEqual(ix.keys.map((k) => +k.isWritable).join(""), "1000000111100");
  assert.deepEqual(ix.keys.map((k) => +k.isSigner).join(""), "1000000000000");
});

test("creator fee waiting on the curve, zero on accounts older than the field", () => {
  const curve = Buffer.alloc(166);
  curve.writeBigUInt64LE(623_346_127n, 125);
  assert.equal(waitingCreatorFee(curve), 623_346_127n);
  assert.equal(waitingCreatorFee(curve.subarray(0, 125)), 0n);
  assert.equal(waitingCreatorFee(null), 0n);
});

test("the pool creator fee sweep matches a real mainnet PumpSwap sweep_creator_fee", () => {
  // PW5Z7UJkxgfmQvL617caqd64WzbNJzFTuguZECUfw94Y2CYh31tQKvdzcDhSZFh4GVP7ZSXS6xJVdwZZX6G7R1p: a graduated token's
  // sole shareholder sweeping its pool, then transfer_creator_fees_to_pump and distribute, as the bot does.
  const mint = new PublicKey("9jEbkZPhcwYCpYEiyNj5NPdj1ewNRppc7XQBSupVpump");
  const payer = new PublicKey("BzSiqsPDM8N87UAf2rRz8XpT6xunH2R7eDW92LbFvgd");
  assert.equal(feeAccounts(mint).pool.toBase58(), "6sCKfP4A5ZCi4ESAEAXJKbTJfry5EpL4ywMoViYrsn7h");
  const ix = sweepPoolCreatorFeeIx(mint, payer);
  assert.ok(ix.programId.equals(PUMP_AMM));
  assert.deepEqual([...ix.data], [32, 246, 191, 52, 8, 201, 73, 186]);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [
    "BzSiqsPDM8N87UAf2rRz8XpT6xunH2R7eDW92LbFvgd", "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw", "6sCKfP4A5ZCi4ESAEAXJKbTJfry5EpL4ywMoViYrsn7h",
    "So11111111111111111111111111111111111111112", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "9jzMquCiLHhfUNvJhAYGCS1TwGnrHwW8cs8Pbxoj3KAi",
    "98f6PMGQFAZnpRuu16J71MNuqZm8ZbEuo7vsATyFVDBL", "H6cZpA9eftnsMSybDe876M21mUxW3ypd4LYkwAufWcDo", "11111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  ]);
  // The recipient is read-only (as in the IDL, and in 3ccsEowbhC7m…, a sweep alone in its transaction).
  assert.deepEqual(ix.keys.map((k) => +k.isWritable).join(""), "101001010000");
  assert.deepEqual(ix.keys.map((k) => +k.isSigner).join(""), "100000000000");
  assert.ok(ix.keys[6].pubkey.equals(feeAccounts(mint).ammVaultAuthority) && ix.keys[7].pubkey.equals(feeAccounts(mint).ammVaultAta));
});

test("creator fee waiting in the pool, zero on accounts older than the field", () => {
  const pool = Buffer.alloc(301);
  pool.writeBigUInt64LE(29_330_072n, 271); // protocol fees, not ours
  pool.writeBigUInt64LE(1_102_282_775n, 279);
  assert.equal(waitingPoolCreatorFee(pool), 1_102_282_775n);
  assert.equal(waitingPoolCreatorFee(pool.subarray(0, 279)), 0n);
  assert.equal(waitingPoolCreatorFee(null), 0n);
});

test("PumpSwap fees go back to the pump.fun creator vault first", () => {
  const ix = transferAmmFeesIx(MINT);
  assert.ok(ix.programId.equals(PUMP_AMM));
  assert.deepEqual([...ix.data], [139, 52, 134, 85, 228, 229, 108, 241]);
  assert.ok(ix.keys[4].pubkey.equals(feeAccounts(MINT).sharingConfig), "coin creator is the sharing config");
  assert.ok(ix.keys[7].pubkey.equals(feeAccounts(MINT).creatorVault));
  assert.ok(ix.keys.every((k) => !k.isSigner));
});
