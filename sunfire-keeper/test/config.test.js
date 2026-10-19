import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.js";

const MINT = "Eowpa4SXEkjsMawvqKwWwayrt3rRS8aJpeThV4dDpump";

test("fee share is off unless FEE_SHARE_WALLET is set, and defaults to 50 %", () => {
  assert.equal(loadConfig({ SFIRE_MINT: MINT }).feeShareWallet, null);
  const team = Keypair.generate().publicKey.toBase58();
  const cfg = loadConfig({ SFIRE_MINT: MINT, FEE_SHARE_WALLET: team });
  assert.equal(cfg.feeShareWallet.toBase58(), team);
  assert.equal(cfg.feeShareBps, 5000);
  assert.equal(loadConfig({ SFIRE_MINT: MINT, FEE_SHARE_WALLET: team, FEE_SHARE_PERCENT: "37.5" }).feeShareBps, 3750);
});

test("fee share refuses a bad address, the bot's own wallet and more than 100 %", () => {
  assert.throws(() => loadConfig({ SFIRE_MINT: MINT, FEE_SHARE_WALLET: "not-an-address" }), /FEE_SHARE_WALLET is not a valid/);
  const bot = Keypair.generate();
  assert.throws(() => loadConfig({ SFIRE_MINT: MINT, KEEPER_SECRET_KEY: bs58.encode(bot.secretKey), FEE_SHARE_WALLET: bot.publicKey.toBase58() }), /another wallet/);
  assert.throws(() => loadConfig({ SFIRE_MINT: MINT, FEE_SHARE_WALLET: Keypair.generate().publicKey.toBase58(), FEE_SHARE_PERCENT: "120" }), /between 0 and 100/);
});
