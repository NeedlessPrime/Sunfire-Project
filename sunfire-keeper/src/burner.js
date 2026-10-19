import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ata } from "./program.js";
import { decodeSharingConfig, distributeIx, feeAccounts, transferAmmFeesIx } from "./pumpfees.js";
import { randomBps } from "./solar.js";

export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Lamports a system account must keep to stay rent-exempt. */
const RENT_FLOOR = 890_880n;
const KEY_RE = /key=([A-Za-z0-9-]+)/g;

const sol = (lamports) => (Number(lamports) / 1e9).toFixed(4);

/**
 * Bot-only mode: no program. Creator fees reach the bot wallet through
 * pump.fun fee sharing; on every M/X flare or G4+ storm the bot spends a
 * random share of its own balance on $SFIRE through Jupiter and burns all of
 * it. Each buyback carries a public memo naming the NOAA event; the bot reads
 * its own memos back so an event is never bought twice, even after a restart.
 */
export class Burner {
  constructor({ cfg, chain, readEvents, buildSwap, alert = async () => {}, log = console.log, now = () => Date.now() }) {
    Object.assign(this, { cfg, chain, readEvents, buildSwap, alert, log, now });
    this.signer = cfg.keeper.publicKey;
    this.handled = new Set();
    this.lastCrank = -Infinity;
  }

  async tick() {
    await this.crankFees();
    await this.burnHeld();
    const events = await this.readEvents(Math.floor(this.now() / 1000));
    if (events.length === 0) return;
    const done = await this.burnedKeys();
    const next = events.find((e) => !done.has(e.key) && !this.handled.has(e.key));
    if (next) await this.buyback(next);
  }

  /** Event keys already bought, from this wallet's own memos. */
  async burnedKeys() {
    const keys = new Set(this.handled);
    for (const memo of await this.chain.recentMemos(this.signer)) {
      for (const m of memo.matchAll(KEY_RE)) keys.add(m[1]);
    }
    return keys;
  }

  async buyback(event) {
    const balance = await this.chain.lamports(this.signer);
    const spendable = balance - this.cfg.reserveLamports;
    const seed = createHash("sha256").update(`${await this.chain.latestBlockhash()}:${event.key}`).digest();
    const bps = randomBps(event.tier, seed);
    const amount = spendable > 0n ? (spendable * BigInt(bps)) / 10_000n : 0n;
    if (amount < this.cfg.minBuyLamports) {
      this.handled.add(event.key);
      return this.log(`${event.label}: ${sol(amount)} SOL to spend (${bps / 100} % of ${sol(spendable > 0n ? spendable : 0n)}), below the ${sol(this.cfg.minBuyLamports)} SOL minimum, skipped`);
    }

    const swap = await this.buildSwap({
      api: this.cfg.jupiterApi,
      apiKey: this.cfg.jupiterApiKey,
      amount,
      sfireMint: this.cfg.sfireMint,
      user: this.signer,
      slippageBps: this.cfg.slippageBps,
      dexes: this.cfg.jupiterDexes,
    });
    const memo = `SunFire buyback key=${event.key} event="${event.noaa}" share=${bps / 100}% sol=${sol(amount)}`;
    const label = `${event.label}: buy ${sol(amount)} SOL of $SFIRE (${bps / 100} %), at least ${swap.minOut}`;
    const sig = await this.chain.send(label, [...swap.instructions, memoIx(this.signer, memo)], { lookupTables: swap.lookupTables });
    this.handled.add(event.key);
    if (sig) {
      await this.alert(`🔥 ${label}`);
      await this.burnHeld(event.key);
    }
  }

  /** Burns every $SFIRE the wallet holds. The wallet only ever holds tokens bought to burn. */
  async burnHeld(key) {
    const mint = this.cfg.sfireMint;
    this.mintProgram ??= await this.chain.ownerOf(mint);
    const account = ata(this.signer, mint, this.mintProgram);
    const amount = await this.chain.tokenBalance(account);
    if (amount === 0n) return;
    const decimals = (await this.chain.accountData(mint))[44];
    const memo = `SunFire burn${key ? ` key=${key}` : ""} amount=${amount}`;
    const sig = await this.chain.send(`burn ${amount} $SFIRE`, [burnCheckedIx(account, mint, this.signer, amount, decimals, this.mintProgram), memoIx(this.signer, memo)]);
    if (sig) await this.alert(`🔥 burned ${amount} $SFIRE`);
  }

  /** Pays out the token's shared creator fees, at most every FEE_CRANK_MINUTES. */
  async crankFees() {
    if (!this.cfg.feeCrankMs || this.now() - this.lastCrank < this.cfg.feeCrankMs) return;
    this.lastCrank = this.now();
    const mint = this.cfg.sfireMint;
    const a = feeAccounts(mint);
    const data = await this.chain.accountData(a.sharingConfig);
    if (!data) return this.warnOnce("No pump.fun fee sharing for this token yet, nothing to distribute");
    const { shareholders } = decodeSharingConfig(data);
    if (!shareholders.some((s) => s.address.equals(this.signer))) {
      this.warnOnce(`This bot (${this.signer.toBase58()}) is not a fee shareholder of the token`);
    }

    const ixs = [];
    if ((await this.chain.tokenBalance(a.ammVaultAta)) >= this.cfg.crankMinLamports) ixs.push(transferAmmFeesIx(mint));
    const curveFees = (await this.chain.lamports(a.creatorVault)) - RENT_FLOOR;
    if (ixs.length === 0 && curveFees < this.cfg.crankMinLamports) return;
    ixs.push(distributeIx(mint, shareholders));
    await this.chain.send(`distribute creator fees (${shareholders.map((s) => `${s.shareBps / 100} %`).join(" / ")})`, ixs);
  }

  warnOnce(text) {
    this.warned ??= new Set();
    if (this.warned.has(text)) return;
    this.warned.add(text);
    this.log(`Warning: ${text}`);
  }
}

export function memoIx(signer, text) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, "utf8"),
  });
}

/** BurnChecked (instruction 15), same layout in SPL Token and Token-2022. */
export function burnCheckedIx(account, mint, owner, amount, decimals, tokenProgram) {
  const data = Buffer.alloc(10);
  data.writeUInt8(15, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
