import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { buildSwap, buildWalletSwap } from "../src/jupiter.js";
import { JUPITER_V6, WSOL_MINT } from "../src/program.js";

const burnVault = Keypair.generate().publicKey;
const vaultSfire = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const sfireMint = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;

const ixJson = (programId, accounts, data = "AQID") => ({ programId: programId.toBase58(), accounts, data });
const quote = { inAmount: "95000000", outAmount: "123456", otherAmountThreshold: "119752", priceImpactPct: "0.12" };

function fakeFetch(swapBody) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const body = url.includes("/quote?") ? quote : swapBody;
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchFn };
}

const goodSwap = {
  computeBudgetInstructions: [],
  setupInstructions: [],
  swapInstruction: ixJson(JUPITER_V6, [
    { pubkey: burnVault.toBase58(), isSigner: true, isWritable: false },
    { pubkey: other.toBase58(), isSigner: false, isWritable: true },
  ]),
  addressLookupTableAddresses: [other.toBase58()],
};

const args = (fetchFn) => ({ api: "https://jup.test/swap/v1", fetchFn, amount: 95_000_000n, sfireMint, burnVault, vaultSfire, payer, slippageBps: 300 });

test("quotes wSOL → $SFIRE for the exact amount", async () => {
  const { calls, fetchFn } = fakeFetch(goodSwap);
  await buildSwap(args(fetchFn));
  const q = new URL(calls[0].url);
  assert.equal(q.pathname, "/swap/v1/quote");
  assert.equal(q.searchParams.get("inputMint"), WSOL_MINT.toBase58());
  assert.equal(q.searchParams.get("outputMint"), sfireMint.toBase58());
  assert.equal(q.searchParams.get("amount"), "95000000");
  assert.equal(q.searchParams.get("slippageBps"), "300");
});

test("asks for a route paid from the burn vault, rent paid by the keeper", async () => {
  const { calls, fetchFn } = fakeFetch(goodSwap);
  await buildSwap(args(fetchFn));
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.userPublicKey, burnVault.toBase58());
  assert.equal(body.payer, payer.toBase58());
  assert.equal(body.wrapAndUnwrapSol, false);
  assert.equal(body.destinationTokenAccount, vaultSfire.toBase58());
});

test("returns Jupiter's minimum, and the vault is not an outer signer", async () => {
  const { fetchFn } = fakeFetch(goodSwap);
  const s = await buildSwap(args(fetchFn));
  assert.equal(s.minOut, 119_752n);
  assert.equal(s.outAmount, 123_456n);
  assert.equal(s.remaining[0].isSigner, false);
  assert.ok(s.remaining[0].pubkey.equals(burnVault));
  assert.deepEqual([...s.data], [1, 2, 3]);
  assert.equal(s.lookupTables.length, 1);
});

test("Jupiter's price impact is a fraction, returned in percent", async () => {
  const { fetchFn } = fakeFetch(goodSwap);
  assert.equal((await buildSwap(args(fetchFn))).priceImpactPct, 12);
});

// ---- bot-only mode: the bot wallet buys like any wallet ----

const user = Keypair.generate().publicKey;
/** A pool paying 1000 tokens per lamport for a tiny buy and 10 % less for anything bigger. */
function walletFetch() {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    let body = { ...goodSwap, swapInstruction: ixJson(JUPITER_V6, [{ pubkey: user.toBase58(), isSigner: true, isWritable: true }]) };
    if (url.includes("/quote?")) {
      const amount = BigInt(new URL(url).searchParams.get("amount"));
      const out = amount === 1_000_000n ? amount * 1000n : (amount * 900n);
      // Like Jupiter on pump.fun's bonding curve: no price impact reported.
      body = { inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String((out * 97n) / 100n), priceImpactPct: "0" };
    }
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchFn };
}
const walletArgs = (fetchFn) => ({ api: "https://jup.test/swap/v1", fetchFn, amount: 100_000_000n, sfireMint, user, slippageBps: 300, dexes: "Pump.fun" });

test("bot-only buys measure the price impact against a 0.001 SOL buy", async () => {
  const { calls, fetchFn } = walletFetch();
  const s = await buildWalletSwap(walletArgs(fetchFn));
  assert.ok(Math.abs(s.priceImpactPct - 10) < 1e-9, String(s.priceImpactPct));
  const quotes = calls.filter((c) => c.url.includes("/quote?")).map((c) => new URL(c.url).searchParams);
  assert.deepEqual(quotes.map((q) => q.get("amount")), ["100000000", "1000000"]);
  assert.ok(quotes.every((q) => q.get("dexes") === "Pump.fun"), "both quotes on the same DEX");
  const body = JSON.parse(calls.find((c) => c.url.endsWith("/swap-instructions")).init.body);
  assert.equal(body.quoteResponse.inAmount, "100000000", "the swap is built from the full quote");
  assert.equal(body.userPublicKey, user.toBase58());
  assert.equal(s.minOut, 87_300_000_000n);
});

test("refuses a swap that is not Jupiter v6", async () => {
  const { fetchFn } = fakeFetch({ ...goodSwap, swapInstruction: ixJson(other, []) });
  await assert.rejects(buildSwap(args(fetchFn)), /Unexpected swap program/);
});

test("surfaces Jupiter errors", async () => {
  const fetchFn = async () => ({ ok: false, status: 400, text: async () => "No routes found" });
  await assert.rejects(buildSwap(args(fetchFn)), /quote 400: No routes found/);
});
