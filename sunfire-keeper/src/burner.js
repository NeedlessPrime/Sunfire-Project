import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ata, ATA_PROGRAM, JUPITER_V6, TOKEN_PROGRAM, WSOL_MINT } from "./program.js";
import { decodeSharingConfig, distributeIx, feeAccounts, transferAmmFeesIx } from "./pumpfees.js";
import { randomBps } from "./solar.js";

export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Lamports a system account must keep to stay rent-exempt. */
const RENT_FLOOR = 890_880n;
const KEY_RE = /key=([A-Za-z0-9-]+)/g;
/** Most SOL a buyback may cost beyond its amount: fees and rent for the token account and pump.fun's volume accumulator. */
const MAX_OVERHEAD = 10_000_000n;
const SWAP_PROGRAMS = [ComputeBudgetProgram.programId, SystemProgram.programId, TOKEN_PROGRAM, ATA_PROGRAM, JUPITER_V6];

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
    const since = Math.floor(this.now() / 1000) - this.cfg.maxEventAgeSec - 3600;
    for (const memo of await this.chain.signedMemosSince(this.signer, since)) {
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
    if (swap.priceImpactPct > this.cfg.maxPriceImpactPct) {
      return this.log(`${event.label}: price impact ${swap.priceImpactPct} % above ${this.cfg.maxPriceImpactPct} %, retrying later`);
    }
    const memo = `SunFire buyback key=${event.key} event="${event.noaa}" share=${bps / 100}% sol=${sol(amount)}`;
    const label = `${event.label}: buy ${sol(amount)} SOL of $SFIRE (${bps / 100} %), at least ${swap.minOut}`;
    const ixs = [...swap.instructions, memoIx(this.signer, memo)];
    await this.checkSwap(ixs, swap, amount);
    const sig = await this.chain.send(label, ixs, { lookupTables: swap.lookupTables });
    this.handled.add(event.key);
    if (sig) {
      await this.alert(`🔥 ${label}`);
      await this.burnHeld(event.key);
    }
  }

  /**
   * The bot signs what Jupiter's API returns, so it never trusts it blindly:
   * only known programs, SOL only moves into its own wSOL account, and a
   * simulation must show at most `amount` (plus fees and rent) leaving the
   * wallet and at least `minOut` $SFIRE arriving in its own token account.
   */
  async checkSwap(ixs, swap, amount) {
    const wsol = ata(this.signer, WSOL_MINT, TOKEN_PROGRAM);
    for (const ix of ixs) {
      if (ix.programId.equals(MEMO_PROGRAM)) continue;
      if (!SWAP_PROGRAMS.some((p) => p.equals(ix.programId))) throw new Error(`Swap refused: unexpected program ${ix.programId.toBase58()}`);
      if (ix.programId.equals(SystemProgram.programId)) {
        const transfer = ix.data.length === 12 && ix.data.readUInt32LE(0) === 2;
        if (!transfer || !ix.keys[0].pubkey.equals(this.signer) || !ix.keys[1].pubkey.equals(wsol)) throw new Error("Swap refused: SOL sent somewhere else than the bot's wSOL account");
      }
      if (ix.programId.equals(TOKEN_PROGRAM)) {
        const kind = ix.data[0];
        const ok = (kind === 17 && ix.keys[0].pubkey.equals(wsol)) // SyncNative
          || (kind === 9 && ix.keys[0].pubkey.equals(wsol) && ix.keys[1].pubkey.equals(this.signer)); // CloseAccount back to the bot
        if (!ok) throw new Error(`Swap refused: unexpected token instruction ${kind}`);
      }
    }

    this.mintProgram ??= await this.chain.ownerOf(this.cfg.sfireMint);
    const tokenAccount = ata(this.signer, this.cfg.sfireMint, this.mintProgram);
    const before = await this.chain.tokenBalance(tokenAccount);
    const balance = await this.chain.lamports(this.signer);
    const sim = await this.chain.simulate(ixs, { lookupTables: swap.lookupTables, watch: [this.signer, tokenAccount] });
    if (sim.err) throw new Error(`Swap simulation failed: ${JSON.stringify(sim.err)} ${sim.logs.slice(-4).join(" | ")}`);
    const [wallet, tokens] = sim.accounts;
    const spent = balance - (wallet?.lamports ?? 0n);
    const bought = (tokens ? tokens.data.readBigUInt64LE(64) : 0n) - before;
    if (spent > amount + MAX_OVERHEAD) throw new Error(`Swap refused: would spend ${sol(spent)} SOL for a ${sol(amount)} SOL buyback`);
    if (bought < swap.minOut) throw new Error(`Swap refused: would bring ${bought} $SFIRE to the bot, expected at least ${swap.minOut}`);
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
