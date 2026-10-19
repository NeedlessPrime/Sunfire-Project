import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { Keeper } from "../src/keeper.js";
import { discriminator, JUPITER_V6, PUMP_PROGRAMS, pumpVolumeAccumulators, TOKEN_PROGRAM, VAULT_FLOOR } from "../src/program.js";

const programId = Keypair.generate().publicKey;
const keeperKey = Keypair.generate();
const sfireMint = Keypair.generate().publicKey;
const MIN = 60_000;

const cfg = (over = {}) => ({
  programId, keeper: keeperKey, dryRun: false, slippageBps: 300, budgetUseBps: 9500,
  disarmAfterMs: 60 * MIN, distributeMinLamports: 50_000_000, jupiterApi: "x", jupiterApiKey: "", ...over,
});

const baseState = () => ({
  keeper: keeperKey.publicKey, devWallet: Keypair.generate().publicKey, sfireMint,
  mFired: false, xFired: false, stormFired: false, pendingBudget: 0n, pendingTier: 0,
});

class FakeChain {
  constructor(state, { feeVault = VAULT_FLOOR, burnVault = 10_000_000_000n } = {}) {
    Object.assign(this, { state, feeVault, burnVault, sent: [] });
  }
  async readConfig() { return this.state && { ...this.state }; }
  async lamports(pk) { return pk.toBase58() === this.feeVaultKey ? this.feeVault : this.burnVault; }
  async ownerOf() { return TOKEN_PROGRAM; }
  async exists(pk) { return !(this.missing ?? []).includes(pk.toBase58()); }
  async send(label, ixs) {
    const names = ixs.map((ix) => ix.programId.equals(programId) ? NAMES.get(ix.data.subarray(0, 8).toString("hex")) : "other");
    this.sent.push({ label, names, ixs });
    if (this.onSend) this.onSend(names);
    return "sig";
  }
}
const NAMES = new Map(["arm", "sync", "disarm", "distribute", "execute"].map((n) => [discriminator("global", n).toString("hex"), n]));
const ofProgram = (chain) => chain.sent.flatMap((s) => s.names.filter((n) => n !== "other"));

const swapOk = async ({ amount, burnVault }) => ({
  inAmount: amount, outAmount: 1000n, minOut: 970n, priceImpactPct: 0,
  remaining: [{ pubkey: burnVault, isSigner: false, isWritable: true }], data: Buffer.from([1]),
  setup: [], computeBudget: [], lookupTables: [],
});
const reading = (value) => ({ value, observedAt: 1_760_000_000 });

function makeKeeper({ state = baseState(), chainOpts, noaa, swap = swapOk, over, clock } = {}) {
  const chain = new FakeChain(state, chainOpts);
  const k = new Keeper({
    cfg: cfg(over), chain,
    readNoaa: noaa ?? (async () => ({ xray: reading(2_000), kp: reading(300) })),
    buildSwap: swap, alert: async (m) => alerts.push(m), log: () => {}, now: clock ?? (() => 0),
  });
  chain.feeVaultKey = k.accounts(state).fee_vault.toBase58();
  const alerts = [];
  return { k, chain, alerts };
}

test("quiet Sun: no transaction", async () => {
  const { k, chain } = makeKeeper();
  await k.tick();
  assert.deepEqual(chain.sent, []);
});

test("M flare: arm with the NOAA reading, then execute the armed budget", async () => {
  const { k, chain } = makeKeeper({ noaa: async () => ({ xray: reading(23_500), kp: reading(300) }) });
  chain.onSend = (names) => { if (names.includes("arm")) chain.state.pendingBudget = 300_000_000n; };
  const swaps = [];
  k.buildSwap = async (a) => { swaps.push(a); return swapOk(a); };
  await k.tick();
  assert.deepEqual(ofProgram(chain), ["arm", "execute"]);
  const armIx = chain.sent[0].ixs[0];
  assert.equal(armIx.data.readUInt8(8), 0, "tier M");
  assert.equal(armIx.data.readBigUInt64LE(9), 23_500n);
  // 95 % of the armed budget goes into the swap, the rest covers pump.fun fees.
  assert.equal(swaps[0].amount, 285_000_000n);
  assert.ok(swaps[0].payer.equals(keeperKey.publicKey));
});

test("execute keeps failing: retried, then disarmed after 60 minutes with an alert", async () => {
  let t = 0;
  const state = { ...baseState(), pendingBudget: 300_000_000n };
  const { k, chain, alerts } = makeKeeper({ state, clock: () => t, swap: async () => { throw new Error("No routes found"); } });
  await k.tick();
  t = 59 * MIN; await k.tick();
  assert.deepEqual(ofProgram(chain), [], "no disarm before the delay");
  t = 60 * MIN; await k.tick();
  assert.deepEqual(ofProgram(chain), ["disarm"]);
  assert.match(alerts.at(-1), /Disarming.*No routes found/);
});

test("a successful execute resets the disarm timer", async () => {
  let t = 0, fail = true;
  const state = { ...baseState(), pendingBudget: 300_000_000n };
  const { k, chain } = makeKeeper({ state, clock: () => t, swap: async (a) => { if (fail) throw new Error("busy"); return swapOk(a); } });
  await k.tick();
  fail = false; t = 30 * MIN; await k.tick();
  assert.deepEqual(ofProgram(chain), ["execute"]);
  assert.equal(k.pendingSince, null);
});

test("calm again after a flare: sync with the latest readings", async () => {
  const { k, chain } = makeKeeper({ state: { ...baseState(), mFired: true } });
  await k.tick();
  assert.deepEqual(ofProgram(chain), ["sync"]);
  const data = chain.sent[0].ixs[0].data;
  assert.equal(data.readBigUInt64LE(8), 2_000n);
  assert.equal(data.readBigUInt64LE(16), 300n);
});

test("fees above the threshold are distributed", async () => {
  const { k, chain } = makeKeeper({ chainOpts: { feeVault: VAULT_FLOOR + 60_000_000n } });
  await k.tick();
  assert.deepEqual(ofProgram(chain), ["distribute"]);
});

test("small fee balances wait", async () => {
  const { k, chain } = makeKeeper({ chainOpts: { feeVault: VAULT_FLOOR + 10_000_000n } });
  await k.tick();
  assert.deepEqual(chain.sent, []);
});

test("NOAA down: no transaction, alert after 15 minutes", async () => {
  let t = 0;
  const { k, chain, alerts } = makeKeeper({ clock: () => t, noaa: async () => { throw new Error("timeout"); } });
  await k.tick();
  assert.equal(alerts.length, 0);
  t = 15 * MIN; await k.tick();
  assert.equal(chain.sent.length, 0);
  assert.match(alerts[0], /NOAA data unreachable/);
});

test("dry run: arm is only passed to the chain layer, which simulates, and a swap preview is computed", async () => {
  const swaps = [];
  const { k, chain } = makeKeeper({
    over: { dryRun: true },
    noaa: async () => ({ xray: reading(150_000), kp: reading(300) }),
    swap: async (a) => { swaps.push(a); return swapOk(a); },
  });
  await k.tick();
  assert.deepEqual(ofProgram(chain), ["arm"]);
  assert.equal(swaps.length, 1, "preview quote");
  assert.equal(chain.sent[0].ixs[0].data.readUInt8(8), 1, "tier X");
});

test("Jupiter setup that needs the vault to sign is refused", async () => {
  const state = { ...baseState(), pendingBudget: 300_000_000n };
  const { k, chain } = makeKeeper({
    state,
    swap: async (a) => ({ ...(await swapOk(a)), setup: [{ programId: JUPITER_V6, keys: [{ pubkey: a.burnVault, isSigner: true, isWritable: true }] }] }),
  });
  await k.tick();
  assert.deepEqual(ofProgram(chain), []);
});

test("program not initialized: nothing happens", async () => {
  const { k, chain } = makeKeeper({ state: null });
  await k.tick();
  assert.deepEqual(chain.sent, []);
});

test("first burn: creates the vault's missing pump.fun volume accumulators before the swap", async () => {
  const { k, chain } = makeKeeper({ state: { ...baseState(), pendingBudget: 300_000_000n, pendingTier: 0 } });
  const [curve, amm] = pumpVolumeAccumulators(k.signer, k.accounts(chain.state).burn_vault);
  chain.missing = [curve.address.toBase58()];
  await k.tick();
  const ixs = chain.sent.find((s) => s.names.includes("execute")).ixs;
  const pumpIxs = ixs.filter((ix) => PUMP_PROGRAMS.some((p) => ix.programId.equals(p)));
  assert.equal(pumpIxs.length, 1, "only the missing accumulator is created");
  assert.ok(pumpIxs[0].keys[2].pubkey.equals(curve.address));
  assert.ok(!ixs.some((ix) => ix.keys.some((key) => key.pubkey.equals(amm.address))), "the existing one is left alone");
  assert.ok(ixs.indexOf(pumpIxs[0]) < ixs.findIndex((ix) => ix.programId.equals(k.cfg.programId)), "created before execute");
});
