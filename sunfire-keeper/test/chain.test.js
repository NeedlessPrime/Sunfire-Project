import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Chain } from "../src/chain.js";

function stubbed(dryRun) {
  const signer = Keypair.generate();
  const chain = new Chain({ rpcUrl: "http://127.0.0.1:1", programId: Keypair.generate().publicKey, signer, dryRun, log: () => {} });
  const calls = { simulate: 0, send: 0 };
  chain.conn = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 }),
    getAddressLookupTable: async () => ({ value: null }),
    simulateTransaction: async (tx) => { calls.simulate++; calls.tx = tx; return { value: { err: null, logs: [] } }; },
    sendTransaction: async (tx) => { calls.send++; calls.tx = tx; return "sig1"; },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  const ix = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  return { chain, calls, ix, signer };
}

test("dry run simulates and never sends", async () => {
  const { chain, calls, ix } = stubbed(true);
  assert.equal(await chain.send("t", [ix]), null);
  assert.deepEqual([calls.simulate, calls.send], [1, 0]);
});

test("live mode sends a signed v0 transaction paid by the keeper, with a compute limit", async () => {
  const { chain, calls, ix, signer } = stubbed(false);
  assert.equal(await chain.send("t", [ix], { computeUnits: 1_000_000 }), "sig1");
  assert.equal(calls.send, 1);
  const msg = calls.tx.message;
  assert.equal(msg.version, 0);
  assert.ok(msg.staticAccountKeys[0].equals(signer.publicKey), "keeper pays");
  assert.equal(msg.compiledInstructions.length, 2, "compute budget + transfer");
  assert.ok(calls.tx.signatures[0].some((b) => b !== 0), "signed");
});

test("a failed confirmation is an error", async () => {
  const { chain, ix } = stubbed(false);
  chain.conn.confirmTransaction = async () => ({ value: { err: { InstructionError: [0, "Custom"] } } });
  await assert.rejects(chain.send("execute", [ix]), /execute failed/);
});

test("memos only count when the bot paid for the transaction, across the whole window", async () => {
  const { chain, signer } = stubbed(false);
  const spoofer = Keypair.generate().publicKey;
  const page1 = [
    { signature: "a", blockTime: 1000, memo: "[40] SunFire buyback key=M-1", err: null },
    { signature: "b", blockTime: 990, memo: "[40] SunFire buyback key=X-2", err: null },
    ...Array.from({ length: 998 }, (_, i) => ({ signature: `spam${i}`, blockTime: 980, memo: null, err: null })),
  ];
  const page2 = [
    { signature: "c", blockTime: 900, memo: "[40] SunFire burn key=M-0", err: null },
    { signature: "old", blockTime: 100, memo: "[40] SunFire buyback key=M-old", err: null },
  ];
  chain.conn.getSignaturesForAddress = async (_pk, { before }) => (before ? page2 : page1);
  chain.conn._rpcRequest = rawTransactions((sig) => ({ transaction: { message: { accountKeys: [(sig === "b" ? spoofer : signer.publicKey).toBase58()] } } }));
  const memos = await chain.signedMemosSince(signer.publicKey, 500);
  assert.deepEqual(memos, ["[40] SunFire buyback key=M-1", "[40] SunFire burn key=M-0"]);
});

test("a memo whose transaction is not indexed yet stops the tick instead of being skipped", async () => {
  const { chain, signer } = stubbed(false);
  chain.conn.getSignaturesForAddress = async () => [{ signature: "a", blockTime: 1000, memo: "[60] SunFire fee share for=x", err: null }];
  let indexed = false;
  chain.conn._rpcRequest = rawTransactions(() => (indexed ? { transaction: { message: { accountKeys: [signer.publicKey.toBase58()] } } } : null));
  await assert.rejects(chain.signedMemosSince(signer.publicKey, 500), /not indexed yet/);
  indexed = true;
  assert.deepEqual(await chain.signedMemosSince(signer.publicKey, 500), ["[60] SunFire fee share for=x"]);
});

test("payouts in real mainnet distribute_creator_fees transactions, including a version 1 one", async () => {
  // Trimmed from mainnet, October 2026. Expected lamports: the vault's System transfers to the shareholder.
  // A version 1 transaction (token-quoted coin, nothing to pay out), a v0 one cranked by someone
  // else, and a legacy one cranked by the shareholder itself, which paid the fee.
  const real = JSON.parse(readFileSync(new URL("./fixtures/distributes.json", import.meta.url), "utf8"));
  assert.deepEqual(real.map((r) => r.tx.version), [1, 0, "legacy"]);
  const { chain } = stubbed(false);
  chain.conn._rpcRequest = rawTransactions((sig) => real.find((r) => r.signature === sig).tx);
  for (const r of real) {
    assert.equal(await chain.payoutIn(r.signature, new PublicKey(r.shareholder), new PublicKey(r.vault)), BigInt(r.lamports), r.signature);
  }
});

/** A stub of the RPC's getTransaction, as raw JSON. */
function rawTransactions(bySignature, fetched = []) {
  return async (method, [signature, opts]) => {
    assert.equal(method, "getTransaction");
    assert.equal(opts.maxSupportedTransactionVersion, 1, "version 1 transactions must be readable");
    fetched.push(signature);
    return { jsonrpc: "2.0", id: 1, result: bySignature(signature) ?? null };
  };
}

test("fee payouts: vault transactions that left the bot richer, fee added back when it paid, oldest first", async () => {
  const { chain, signer } = stubbed(false);
  const vault = Keypair.generate().publicKey;
  const cranker = Keypair.generate().publicKey;
  const lut = Keypair.generate().publicKey;
  const txs = {
    // The bot cranked: it paid 5000 lamports of fee and received 0.1 SOL.
    own: { keys: [signer.publicKey, vault], pre: [1_000_000_000, 0], post: [1_099_995_000, 0], fee: 5000 },
    // Someone else cranked; the bot sits in a lookup table.
    other: { keys: [cranker, vault], loaded: { writable: [signer.publicKey], readonly: [] }, pre: [5, 0, 1_000], post: [0, 0, 51_000], fee: 5000 },
    // A buyback goes through the vault but costs the bot.
    buy: { keys: [signer.publicKey, vault], pre: [1_000_000, 0], post: [500_000, 0], fee: 5000 },
    // A top-up never touches the vault.
    topup: { keys: [cranker, signer.publicKey], pre: [9, 0], post: [0, 9], fee: 0 },
    lut: { keys: [lut], pre: [0], post: [0], fee: 0 },
  };
  chain.conn.getSignaturesForAddress = async () => [
    { signature: "own", blockTime: 1000, err: null },
    { signature: "pending", blockTime: 1000, err: null },
    { signature: "failed", blockTime: 1000, err: { InstructionError: [0, "Custom"] } },
    { signature: "buy", blockTime: 990, err: null },
    { signature: "topup", blockTime: 980, err: null },
    { signature: "other", blockTime: 970, err: null },
    { signature: "old", blockTime: 100, err: null },
  ];
  const fetched = [];
  const b58 = (keys) => keys.map((k) => k.toBase58());
  chain.conn._rpcRequest = rawTransactions((sig) => {
    const t = txs[sig];
    if (!t) return null;
    const loaded = t.loaded && { writable: b58(t.loaded.writable), readonly: b58(t.loaded.readonly) };
    return { transaction: { message: { accountKeys: b58(t.keys) } }, meta: { fee: t.fee, preBalances: t.pre, postBalances: t.post, loadedAddresses: loaded } };
  }, fetched);
  const payouts = await chain.payoutsSince(signer.publicKey, vault, 500);
  assert.deepEqual(payouts, [{ signature: "other", lamports: 50_000n }, { signature: "own", lamports: 100_000_000n }]);
  assert.ok(!fetched.includes("failed") && !fetched.includes("old"));

  fetched.length = 0;
  await chain.payoutsSince(signer.publicKey, vault, 500);
  assert.deepEqual(fetched, ["pending"], "known transactions are not fetched again, unindexed ones are");
});
