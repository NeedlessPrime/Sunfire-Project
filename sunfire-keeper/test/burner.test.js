import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Burner, MEMO_PROGRAM } from "../src/burner.js";
import { ata, JUPITER_V6, TOKEN_PROGRAM, WSOL_MINT } from "../src/program.js";
import { feeAccounts, PUMP, PUMP_AMM } from "../src/pumpfees.js";

const MINT = new PublicKey("Eowpa4SXEkjsMawvqKwWwayrt3rRS8aJpeThV4dDpump");
const SOL = 1_000_000_000n;
const M_FLARE = { key: "M-20261019T1300", tier: "M", label: "M2.0 flare", observedAt: 0, noaa: "M2.0 begin 2026-10-19T13:00:00Z" };
const X_FLARE = { key: "X-20261019T1400", tier: "X", label: "X1.0 flare", observedAt: 1, noaa: "X1.0 begin 2026-10-19T14:00:00Z" };

class FakeChain {
  constructor(signer) {
    Object.assign(this, { signer, balance: 1n * SOL, memos: [], sent: [], payouts: [], tokens: new Map(), data: new Map(), lamportsOf: new Map() });
  }
  async payoutsSince() { return this.payouts; }
  async lamports(pk) { return pk.equals(this.signer) ? this.balance : (this.lamportsOf.get(pk.toBase58()) ?? 0n); }
  async ownerOf() { return TOKEN_PROGRAM; }
  async accountData(pk) { return pk.equals(MINT) ? Buffer.alloc(82, 6) : (this.data.get(pk.toBase58()) ?? null); }
  async tokenBalance(pk) { return this.tokens.get(pk.toBase58()) ?? 0n; }
  async latestBlockhash() { return "11111111111111111111111111111111"; }
  async signedMemosSince() { return this.memos; }
  // Default simulation: the swap spends what it was asked and brings the quoted minimum.
  async simulate(ixs, { watch }) {
    if (this.simulateWith) return this.simulateWith(ixs, watch);
    const tokens = Buffer.alloc(72);
    tokens.writeBigUInt64LE((this.tokens.get(watch[1].toBase58()) ?? 0n) + 900n, 64);
    return { err: null, logs: [], accounts: [{ lamports: this.balance - (this.lastAmount ?? 0n) - 5_000n, data: Buffer.alloc(0) }, { lamports: 2_039_280n, data: tokens }] };
  }
  async send(label, ixs) {
    this.sent.push({ label, ixs });
    const memo = ixs.find((ix) => ix.programId.equals(MEMO_PROGRAM));
    if (memo) this.memos.push(memo.data.toString());
    if (this.onSend) this.onSend(label, ixs);
    return "sig";
  }
}

/** What Jupiter returns for a wallet swap: wrap SOL, sync, route, close the wSOL account. */
function swapIxs(user, amount) {
  const wsol = ata(user, WSOL_MINT, TOKEN_PROGRAM);
  return [
    SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports: amount }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: wsol, isSigner: false, isWritable: true }], data: Buffer.from([17]) }),
    new TransactionInstruction({ programId: JUPITER_V6, keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: Buffer.from([1]) }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: wsol, isSigner: false, isWritable: true }, { pubkey: user, isSigner: false, isWritable: true }, { pubkey: user, isSigner: true, isWritable: false }], data: Buffer.from([9]) }),
  ];
}

function make({ events = [M_FLARE], over = {} } = {}) {
  const keeper = Keypair.generate();
  const chain = new FakeChain(keeper.publicKey);
  const swaps = [];
  const b = new Burner({
    cfg: { keeper, sfireMint: MINT, reserveLamports: SOL / 50n, minBuyLamports: 2_000_000n, slippageBps: 300, feeCrankMs: 0, crankMinLamports: SOL / 100n, maxPriceImpactPct: 5, maxEventAgeSec: 6 * 3600, jupiterApi: "x", ...over },
    chain,
    readEvents: async () => events,
    buildSwap: async (a) => { swaps.push(a); chain.lastAmount = a.amount; return { minOut: 900n, priceImpactPct: 0.4, instructions: swapIxs(keeper.publicKey, a.amount), lookupTables: [] }; },
    log: () => {},
  });
  return { b, chain, swaps, keeper };
}

test("an M flare spends 1-5 % of the balance above the reserve, with a memo naming the event", async () => {
  const { b, chain, swaps } = make();
  await b.tick();
  assert.equal(swaps.length, 1);
  const spendable = SOL - SOL / 50n;
  assert.ok(swaps[0].amount >= spendable / 100n && swaps[0].amount <= spendable / 20n, String(swaps[0].amount));
  assert.match(chain.memos[0], /^SunFire buyback key=M-20261019T1300 event="M2.0 begin 2026-10-19T13:00:00Z" share=\d/);
});

test("an event already in the wallet's memos is never bought again, even after a restart", async () => {
  const { b, chain, swaps } = make();
  chain.memos.push("[90] SunFire buyback key=M-20261019T1300 share=2.5% sol=0.0245");
  await b.tick();
  assert.equal(swaps.length, 0);
});

test("one buyback per tick, oldest event first", async () => {
  const { b, swaps } = make({ events: [M_FLARE, X_FLARE] });
  await b.tick();
  await b.tick();
  assert.deepEqual(swaps.map((s) => s.amount > 0n), [true, true]);
  await b.tick();
  assert.equal(swaps.length, 2);
});

test("nothing is bought below the minimum, and the reserve is never spent", async () => {
  const { b, chain, swaps } = make();
  chain.balance = SOL / 50n + 10_000_000n; // 0.01 SOL above the reserve: 1-5 % is under 0.002 SOL
  await b.tick();
  assert.equal(swaps.length, 0);
});

test("bought tokens are burned with BurnChecked and a burn memo", async () => {
  const { b, chain, keeper } = make();
  const account = ata(keeper.publicKey, MINT, TOKEN_PROGRAM);
  chain.onSend = (label) => { if (label.includes("buy")) chain.tokens.set(account.toBase58(), 1234n); };
  await b.tick();
  const burn = chain.sent.find((s) => s.label.startsWith("burn"));
  assert.ok(burn, "burn sent");
  const ix = burn.ixs[0];
  assert.ok(ix.programId.equals(TOKEN_PROGRAM));
  assert.equal(ix.data[0], 15);
  assert.equal(ix.data.readBigUInt64LE(1), 1234n);
  assert.equal(ix.data[9], 6, "mint decimals");
  assert.ok(ix.keys[0].pubkey.equals(account) && ix.keys[2].pubkey.equals(keeper.publicKey) && ix.keys[2].isSigner);
  assert.match(chain.memos.at(-1), /^SunFire burn key=M-20261019T1300 amount=1234$/);
});

test("fee crank distributes once the creator vault holds enough, and moves PumpSwap fees first", async () => {
  const { b, chain, keeper } = make({ events: [], over: { feeCrankMs: 60_000 } });
  const a = feeAccounts(MINT);
  shareholders(chain, [[keeper.publicKey, 5000], [Keypair.generate().publicKey, 5000]]);

  chain.lamportsOf.set(a.creatorVault.toBase58(), 890_880n + 1_000n);
  await b.tick();
  assert.equal(chain.sent.length, 0, "dust is left alone");

  b.lastCrank = -Infinity;
  chain.tokens.set(a.ammVaultAta.toBase58(), SOL / 10n);
  await b.tick();
  const programs = chain.sent[0].ixs.map((ix) => ix.programId.toBase58());
  assert.deepEqual(programs, [PUMP_AMM.toBase58(), PUMP.toBase58()]);
});

/** Writes the token's pump.fun SharingConfig with these [address, bps] holders. */
function shareholders(chain, holders) {
  const sc = Buffer.alloc(80 + holders.length * 34);
  holders.forEach(([h, bps], i) => { h.toBuffer().copy(sc, 80 + i * 34); sc.writeUInt16LE(bps, 112 + i * 34); });
  sc.writeUInt32LE(holders.length, 76);
  chain.data.set(feeAccounts(MINT).sharingConfig.toBase58(), sc);
}

// ---- fee share: the bot gets all creator fees and forwards a share ----

const TEAM = Keypair.generate().publicKey;
const PAYOUT = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const share = (over = {}) => ({ feeShareWallet: TEAM, feeShareBps: 5000, feeShareLookbackSec: 72 * 3600, ...over });

test("forwards the share of every fee payout, whoever cranked it, with a memo naming the payout", async () => {
  const { b, chain, keeper } = make({ events: [], over: share() });
  chain.payouts = [{ signature: PAYOUT, lamports: SOL / 10n }];
  await b.tick();
  assert.equal(chain.sent.length, 1);
  const [transfer] = chain.sent[0].ixs;
  assert.ok(transfer.programId.equals(SystemProgram.programId));
  assert.ok(transfer.keys[0].pubkey.equals(keeper.publicKey) && transfer.keys[1].pubkey.equals(TEAM));
  assert.equal(transfer.data.readBigUInt64LE(4), SOL / 20n, "50 % of 0.1 SOL");
  assert.equal(chain.memos[0], `SunFire fee share for=${PAYOUT} sol=0.0500`);

  await b.tick();
  assert.equal(chain.sent.length, 1, "paid once");
});

test("a payout already shared in the wallet's memos is never paid again, even after a restart", async () => {
  const { b, chain } = make({ events: [], over: share() });
  chain.payouts = [{ signature: PAYOUT, lamports: SOL / 10n }];
  chain.memos.push(`[120] SunFire fee share for=${PAYOUT} sol=0.0500`);
  await b.tick();
  assert.equal(chain.sent.length, 0);
});

test("the share goes out before a buyback, which then only sees the bot's part", async () => {
  const { b, chain, swaps } = make({ over: share() });
  chain.payouts = [{ signature: PAYOUT, lamports: SOL / 2n }];
  chain.onSend = (label, ixs) => { if (label.includes("fee share")) chain.balance -= ixs[0].data.readBigUInt64LE(4); };
  await b.tick();
  assert.match(chain.sent[0].label, /fee share/);
  assert.match(chain.sent[1].label, /buy/);
  const spendable = SOL - SOL / 4n - SOL / 50n;
  assert.ok(swaps[0].amount <= spendable / 20n, "M flare: at most 5 % of what is left");
});

test("no buyback in the tick that cranked a payout, so its share is paid first", async () => {
  const { b, chain, keeper, swaps } = make({ over: share({ feeCrankMs: 60_000 }) });
  shareholders(chain, [[keeper.publicKey, 10_000]]);
  chain.lamportsOf.set(feeAccounts(MINT).creatorVault.toBase58(), SOL);
  await b.tick();
  assert.match(chain.sent[0].label, /distribute creator fees \(100 %\)/);
  assert.equal(swaps.length, 0, "waits a tick");
  await b.tick();
  assert.equal(swaps.length, 1);
});

test("a share the bot cannot pay pauses buybacks and alerts once", async () => {
  const { b, chain, swaps } = make({ over: share() });
  const alerts = [];
  b.alert = async (t) => alerts.push(t);
  chain.payouts = [{ signature: PAYOUT, lamports: 4n * SOL }];
  await assert.rejects(() => b.tick(), /Buybacks are paused/);
  await assert.rejects(() => b.tick(), /Buybacks are paused/);
  assert.equal(swaps.length, 0);
  assert.equal(chain.sent.length, 0);
  assert.equal(alerts.length, 1);
});

test("warns when the fee share is on but pump.fun still splits the fees", async () => {
  const { b, chain, keeper } = make({ events: [], over: share({ feeCrankMs: 60_000 }) });
  const logs = [];
  b.log = (t) => logs.push(t);
  shareholders(chain, [[keeper.publicKey, 5000], [TEAM, 5000]]);
  await b.tick();
  assert.ok(logs.some((l) => /only gets 50 %.*taken twice/.test(l)), logs.join("\n"));
});

test("a dust share stays with the bot", async () => {
  const { b, chain } = make({ events: [], over: share() });
  chain.payouts = [{ signature: PAYOUT, lamports: 50_000n }];
  await b.tick();
  assert.equal(chain.sent.length, 0);
});

// ---- what the bot refuses to sign ----

async function refused(tamper) {
  const { b, chain, swaps } = make();
  const real = b.buildSwap;
  b.buildSwap = async (a) => tamper(await real(a), a);
  await assert.rejects(() => b.tick(), /refused|failed/);
  assert.ok(!chain.sent.some((s) => s.label.includes("buy")), "nothing sent");
  return swaps;
}

test("refuses a swap with an unknown program", async () => {
  await refused((swap) => ({ ...swap, instructions: [...swap.instructions, new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })] }));
});

test("refuses a swap that sends SOL anywhere but the bot's wSOL account", async () => {
  await refused((swap, a) => {
    const [, ...rest] = swap.instructions;
    return { ...swap, instructions: [SystemProgram.transfer({ fromPubkey: a.user, toPubkey: Keypair.generate().publicKey, lamports: a.amount }), ...rest] };
  });
});

test("refuses a swap that closes the wSOL account to someone else", async () => {
  await refused((swap) => {
    const close = swap.instructions[3];
    const thief = Keypair.generate().publicKey;
    const bad = new TransactionInstruction({ programId: close.programId, keys: [close.keys[0], { pubkey: thief, isSigner: false, isWritable: true }, close.keys[2]], data: close.data });
    return { ...swap, instructions: [...swap.instructions.slice(0, 3), bad] };
  });
});

test("refuses a swap whose simulation brings the tokens elsewhere or spends too much", async () => {
  for (const [spentExtra, tokensIn] of [[0n, 0n], [SOL / 10n, 900n]]) {
    const { b, chain } = make();
    chain.simulateWith = (ixs, watch) => {
      const tokens = Buffer.alloc(72); tokens.writeBigUInt64LE(tokensIn, 64);
      return { err: null, logs: [], accounts: [{ lamports: chain.balance - chain.lastAmount - spentExtra, data: Buffer.alloc(0) }, { lamports: 1n, data: tokens }] };
    };
    await assert.rejects(() => b.tick(), /refused/);
    assert.ok(!chain.sent.some((s) => s.label.includes("buy")));
  }
});

test("waits instead of buying into a thin pool", async () => {
  const { b, chain } = make();
  const real = b.buildSwap;
  b.buildSwap = async (a) => ({ ...(await real(a)), priceImpactPct: 12 });
  await b.tick();
  assert.equal(chain.sent.length, 0);
  b.buildSwap = real;
  await b.tick();
  assert.ok(chain.sent.some((s) => s.label.includes("buy")), "bought once the price impact is acceptable");
});
