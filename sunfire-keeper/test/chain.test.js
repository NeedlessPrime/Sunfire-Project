import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram } from "@solana/web3.js";
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
