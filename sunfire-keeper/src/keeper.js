import { decide, TIER_NAME } from "./events.js";
import { ata, buildIx, createAtaIdempotent, knownAccounts, TOKEN_PROGRAM, VAULT_FLOOR, WSOL_MINT } from "./program.js";

const EXECUTE_COMPUTE_UNITS = 1_000_000;
const NOAA_ALERT_AFTER_MS = 15 * 60_000;

/**
 * One keeper. `tick()` runs a full round: distribute fees, finish or cancel
 * a pending burn, then read NOAA and arm or re-arm triggers.
 */
export class Keeper {
  constructor({ cfg, chain, readNoaa, buildSwap, alert = async () => {}, log = console.log, now = Date.now }) {
    Object.assign(this, { cfg, chain, readNoaa, buildSwap, alert, log, now });
    this.signer = cfg.keeper.publicKey;
    this.pendingSince = null;
    this.noaaFailingSince = null;
    this.warnedKeeper = false;
  }

  async tick() {
    const state = await this.chain.readConfig();
    if (!state) {
      this.log("Program config not found: initialize the program first.");
      return;
    }
    if (!state.keeper.equals(this.signer) && !this.warnedKeeper) {
      this.warnedKeeper = true;
      this.log(`Warning: this bot signs as ${this.signer.toBase58()}, but the program keeper is ${state.keeper.toBase58()}.`);
    }

    await this.safely("distribute", () => this.distribute(state));

    if (state.pendingBudget > 0n) {
      await this.finishPending(state);
      return;
    }
    this.pendingSince = null;

    const readings = await this.readings();
    if (!readings) return;
    for (const action of decide(readings, state)) {
      if (action.type === "sync") {
        await this.safely("sync", () => this.sync(readings));
      } else if (action.type === "arm") {
        const armed = await this.safely("arm", () => this.arm(action, state));
        if (armed && !this.cfg.dryRun) {
          const fresh = await this.chain.readConfig();
          if (fresh?.pendingBudget > 0n) await this.finishPending(fresh);
        }
      }
    }
  }

  async readings() {
    try {
      const r = await this.readNoaa();
      this.noaaFailingSince = null;
      return r;
    } catch (e) {
      this.noaaFailingSince ??= this.now();
      this.log(`NOAA unavailable: ${e.message}`);
      if (this.now() - this.noaaFailingSince >= NOAA_ALERT_AFTER_MS) {
        await this.alert(`NOAA data unreachable for ${Math.round((this.now() - this.noaaFailingSince) / 60_000)} min: ${e.message}`);
        this.noaaFailingSince = this.now();
      }
      return null;
    }
  }

  accounts(state) {
    return knownAccounts(this.cfg.programId, state, this.signer);
  }

  async distribute(state) {
    const a = this.accounts(state);
    const available = (await this.chain.lamports(a.fee_vault)) - VAULT_FLOOR;
    if (available < BigInt(this.cfg.distributeMinLamports)) return false;
    await this.chain.send(`distribute ${sol(available)} SOL`, [buildIx(this.cfg.programId, "distribute", a)]);
    return true;
  }

  async sync({ xray, kp }) {
    const observedAt = Math.max(xray?.observedAt ?? 0, kp?.observedAt ?? 0);
    const args = { xray: xray?.value ?? 0, kp: kp?.value ?? 0, observed_at: observedAt };
    await this.chain.send("sync", [buildIx(this.cfg.programId, "sync", this.accounts(null), args)]);
    return true;
  }

  async arm({ tier, reading }, state) {
    const args = { tier, reading: reading.value, observed_at: reading.observedAt };
    const label = `arm ${TIER_NAME[tier]} (reading ${reading.value} at ${new Date(reading.observedAt * 1000).toISOString()})`;
    await this.chain.send(label, [buildIx(this.cfg.programId, "arm", this.accounts(state), args)]);
    if (this.cfg.dryRun) await this.previewSwap(state);
    return true;
  }

  /** Tries to execute the pending burn, and cancels it after DISARM_AFTER_MINUTES of failures. */
  async finishPending(state) {
    this.pendingSince ??= this.now();
    try {
      await this.execute(state);
      this.pendingSince = null;
    } catch (e) {
      const waited = this.now() - this.pendingSince;
      this.log(`execute failed (${Math.round(waited / 60_000)} min since armed): ${e.message}`);
      if (waited < this.cfg.disarmAfterMs) return;
      await this.alert(`Burn of ${sol(state.pendingBudget)} SOL could not execute for ${Math.round(waited / 60_000)} min. Disarming. Last error: ${e.message}`);
      await this.safely("disarm", () => this.chain.send("disarm", [buildIx(this.cfg.programId, "disarm", this.accounts(state))]));
      this.pendingSince = null;
    }
  }

  async execute(state) {
    const a = this.accounts(state);
    const sfireTokenProgram = await this.chain.ownerOf(state.sfireMint);
    const vaultWsol = ata(a.burn_vault, WSOL_MINT, TOKEN_PROGRAM);
    const vaultSfire = ata(a.burn_vault, state.sfireMint, sfireTokenProgram);
    const amount = (state.pendingBudget * BigInt(this.cfg.budgetUseBps)) / 10_000n;

    const swap = await this.buildSwap({
      api: this.cfg.jupiterApi,
      apiKey: this.cfg.jupiterApiKey,
      amount,
      sfireMint: state.sfireMint,
      burnVault: a.burn_vault,
      vaultSfire,
      payer: this.signer,
      slippageBps: this.cfg.slippageBps,
    });
    if (swap.setup.some((ix) => ix.keys.some((k) => k.isSigner && k.pubkey.equals(a.burn_vault)))) {
      throw new Error("Jupiter setup needs the burn vault to sign, which only the program can do");
    }

    const ix = buildIx(
      this.cfg.programId,
      "execute",
      { ...a, vault_wsol: vaultWsol, vault_sfire: vaultSfire, sfire_token_program: sfireTokenProgram },
      { jupiter_data: swap.data, min_out: swap.minOut },
      swap.remaining,
    );
    const label = `execute ${TIER_NAME[state.pendingTier] ?? "?"} burn: ${sol(amount)} SOL for at least ${swap.minOut} $SFIRE`;
    await this.chain.send(
      label,
      [
        ...swap.computeBudget,
        createAtaIdempotent(this.signer, a.burn_vault, WSOL_MINT, TOKEN_PROGRAM),
        createAtaIdempotent(this.signer, a.burn_vault, state.sfireMint, sfireTokenProgram),
        ...swap.setup,
        ix,
      ],
      { lookupTables: swap.lookupTables, computeUnits: EXECUTE_COMPUTE_UNITS },
    );
    if (!this.cfg.dryRun) await this.alert(`🔥 ${label}`);
  }

  /** Dry run only: shows the swap a real arm would lead to. */
  async previewSwap(state) {
    const a = this.accounts(state);
    const spendable = (await this.chain.lamports(a.burn_vault)) - VAULT_FLOOR;
    if (spendable <= 0n) return this.log("[dry-run] burn vault is empty, no swap to preview");
    const sfireTokenProgram = await this.chain.ownerOf(state.sfireMint);
    const amount = (spendable * 300n) / 10_000n; // mid M-tier share, for the preview only
    const swap = await this.buildSwap({
      api: this.cfg.jupiterApi,
      apiKey: this.cfg.jupiterApiKey,
      amount: (amount * BigInt(this.cfg.budgetUseBps)) / 10_000n,
      sfireMint: state.sfireMint,
      burnVault: a.burn_vault,
      vaultSfire: ata(a.burn_vault, state.sfireMint, sfireTokenProgram),
      payer: this.signer,
      slippageBps: this.cfg.slippageBps,
    });
    this.log(`[dry-run] swap preview: ${sol(swap.inAmount)} SOL → ${swap.outAmount} $SFIRE (min ${swap.minOut}, impact ${swap.priceImpactPct}%)`);
  }

  async safely(what, fn) {
    try {
      return await fn();
    } catch (e) {
      this.log(`${what} failed: ${e.message}`);
      return false;
    }
  }
}

const sol = (lamports) => (Number(lamports) / 1e9).toFixed(4);
