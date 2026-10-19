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
    this.pdas = pdas(programId);
  }

  async readConfig() {
    const info = await this.conn.getAccountInfo(this.pdas.config);
    return info ? decodeConfig(info.data) : null;
  }

  lamports(pubkey) {
    return this.conn.getBalance(pubkey).then(BigInt);
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
  async send(label, instructions, { lookupTables = [], computeUnits } = {}) {
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
