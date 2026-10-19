import { ComputeBudgetProgram, Connection, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { decodeConfig, pdas } from "./program.js";

/** Thin wrapper over the RPC so the keeper logic can be tested with a fake. */
export class Chain {
  constructor({ rpcUrl, programId, signer, dryRun, log = console.log }) {
    this.conn = new Connection(rpcUrl, "confirmed");
    this.programId = programId;
    this.signer = signer;
    this.dryRun = dryRun;
    this.log = log;
    // The bot-only mode has no program.
    this.pdas = programId ? pdas(programId) : null;
  }

  async accountData(pubkey) {
    return (await this.conn.getAccountInfo(pubkey))?.data ?? null;
  }

  async tokenBalance(pubkey) {
    const info = await this.conn.getAccountInfo(pubkey);
    // SPL Token and Token-2022 accounts both keep the amount at bytes 64..72.
    return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
  }

  async latestBlockhash() {
    return (await this.conn.getLatestBlockhash()).blockhash;
  }

  /**
   * SunFire memos of the transactions `pubkey` paid for since `sinceSec`.
   * Anyone can send a transaction that touches the wallet with any memo, so
   * only transactions whose fee payer is `pubkey` count. Pages back through
   * the whole window, so spam cannot push real memos out of view.
   */
  async signedMemosSince(pubkey, sinceSec, { maxPages = 20 } = {}) {
    this.payerOf ??= new Map();
    const candidates = [];
    let before;
    scan: for (let page = 0; page < maxPages; page++) {
      const sigs = await this.conn.getSignaturesForAddress(pubkey, { limit: 1000, before });
      for (const s of sigs) {
        if (s.blockTime && s.blockTime < sinceSec) break scan;
        if (!s.err && s.memo?.includes("SunFire")) candidates.push(s);
      }
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    const memos = [];
    for (const s of candidates) {
      if (!this.payerOf.has(s.signature)) {
        const tx = await this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        this.payerOf.set(s.signature, tx?.transaction.message.staticAccountKeys[0]?.toBase58() ?? null);
      }
      if (this.payerOf.get(s.signature) === pubkey.toBase58()) memos.push(s.memo);
    }
    return memos;
  }

  /**
   * Payouts that reached `pubkey` since `sinceSec`, oldest first: successful
   * transactions that touched `vault` and left `pubkey` richer, whoever sent
   * them, with the lamports each brought (the fee added back when `pubkey`
   * paid it). The bot's own buybacks touch the vault too but leave it poorer.
   */
  async payoutsSince(pubkey, vault, sinceSec, { maxPages = 20 } = {}) {
    this.payoutOf ??= new Map();
    const payouts = [];
    let before;
    scan: for (let page = 0; page < maxPages; page++) {
      const sigs = await this.conn.getSignaturesForAddress(pubkey, { limit: 1000, before });
      for (const s of sigs) {
        if (s.blockTime && s.blockTime < sinceSec) break scan;
        if (s.err) continue;
        if (!this.payoutOf.has(s.signature)) {
          const lamports = await this.payoutIn(s.signature, pubkey, vault);
          // Not indexed yet: look again next time instead of remembering nothing came in.
          if (lamports === null) continue;
          this.payoutOf.set(s.signature, lamports);
        }
        const lamports = this.payoutOf.get(s.signature);
        if (lamports > 0n) payouts.push({ signature: s.signature, lamports });
      }
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    return payouts.reverse();
  }

  async payoutIn(signature, pubkey, vault) {
    const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) return null;
    // Balances follow the account order: static keys, then lookup-table writable, then readonly.
    const { writable = [], readonly = [] } = tx.meta.loadedAddresses ?? {};
    const keys = [...tx.transaction.message.staticAccountKeys, ...writable, ...readonly].map(String);
    const i = keys.indexOf(pubkey.toBase58());
    if (i < 0 || !keys.includes(vault.toBase58())) return 0n;
    const fee = i === 0 ? BigInt(tx.meta.fee) : 0n;
    return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) + fee;
  }

  async readConfig() {
    const info = await this.conn.getAccountInfo(this.pdas.config);
    return info ? decodeConfig(info.data) : null;
  }

  lamports(pubkey) {
    return this.conn.getBalance(pubkey).then(BigInt);
  }

  async exists(pubkey) {
    return (await this.conn.getAccountInfo(pubkey)) !== null;
  }

  async ownerOf(pubkey) {
    const info = await this.conn.getAccountInfo(pubkey);
    if (!info) throw new Error(`Account ${pubkey.toBase58()} not found`);
    return info.owner;
  }

  /**
   * Sends the instructions in one v0 transaction signed by the keeper.
   * In dry-run mode the transaction is only simulated and never sent.
   */
  async build(instructions, { lookupTables = [], computeUnits } = {}) {
    const tables = await Promise.all(lookupTables.map((k) => this.conn.getAddressLookupTable(k).then((r) => r.value)));
    const pre = computeUnits && !instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
      ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })]
      : [];
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: this.signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...pre, ...instructions],
    }).compileToV0Message(tables.filter(Boolean));
    const tx = new VersionedTransaction(message);
    tx.sign([this.signer]);
    return { tx, blockhash, lastValidBlockHeight };
  }

  /**
   * Simulates the instructions and returns the state of `watch` accounts
   * after them, as { lamports, data } or null for an account that would not exist.
   */
  async simulate(instructions, { lookupTables, computeUnits, watch = [] } = {}) {
    const { tx } = await this.build(instructions, { lookupTables, computeUnits });
    const sim = await this.conn.simulateTransaction(tx, {
      sigVerify: false,
      accounts: { encoding: "base64", addresses: watch.map((k) => k.toBase58()) },
    });
    const accounts = (sim.value.accounts ?? []).map((a) => a && { lamports: BigInt(a.lamports), data: Buffer.from(a.data[0], "base64") });
    return { err: sim.value.err, logs: sim.value.logs ?? [], accounts };
  }

  async send(label, instructions, { lookupTables = [], computeUnits } = {}) {
    const { tx, blockhash, lastValidBlockHeight } = await this.build(instructions, { lookupTables, computeUnits });

    if (this.dryRun) {
      const sim = await this.conn.simulateTransaction(tx, { sigVerify: false });
      const ok = !sim.value.err;
      this.log(`[dry-run] ${label}: simulation ${ok ? "ok" : "failed"}`, ok ? "" : JSON.stringify(sim.value.err));
      if (!ok) this.log((sim.value.logs ?? []).slice(-8).join("\n"));
      return null;
    }

    const sig = await this.conn.sendTransaction(tx, { maxRetries: 3 });
    const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)} (${sig})`);
    this.log(`${label}: ${sig}`);
    return sig;
  }
}
