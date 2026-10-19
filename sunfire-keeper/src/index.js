import { makeAlert } from "./alert.js";
import { Chain } from "./chain.js";
import { loadConfig } from "./config.js";
import { Burner } from "./burner.js";
import { buildSwap, buildWalletSwap } from "./jupiter.js";
import { Keeper } from "./keeper.js";
import { readNoaa } from "./noaa.js";
import { readSolarEvents } from "./solar.js";

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const cfg = loadConfig();
const chain = new Chain({ rpcUrl: cfg.rpcUrl, programId: cfg.programId, signer: cfg.keeper, dryRun: cfg.dryRun, log });
const alert = makeAlert(cfg.alertWebhook, { log });
const keeper = cfg.mode === "program"
  ? new Keeper({ cfg, chain, readNoaa: () => readNoaa(), buildSwap, alert, log })
  : new Burner({ cfg, chain, readEvents: (nowSec) => readSolarEvents({ nowSec, maxAgeSec: cfg.maxEventAgeSec }), buildSwap: buildWalletSwap, alert, log });

log(`SunFire keeper ${cfg.dryRun ? "in DRY RUN (simulates only)" : "LIVE"}`);
log(cfg.mode === "program"
  ? `program ${cfg.programId.toBase58()}, keeper ${cfg.keeper.publicKey.toBase58()}, every ${cfg.pollMs / 1000}s`
  : `bot-only mode, token ${cfg.sfireMint.toBase58()}, bot wallet ${cfg.keeper.publicKey.toBase58()}, every ${cfg.pollMs / 1000}s`);
if (cfg.mode === "wallet" && cfg.feeShareWallet) {
  log(`fee share: ${cfg.feeShareBps / 100} % of every creator fee payout goes to ${cfg.feeShareWallet.toBase58()}`);
}

let stopping = false;
let timer;
async function loop() {
  try {
    await keeper.tick();
  } catch (e) {
    log(`tick failed: ${e.message}`);
  }
  if (!stopping) timer = setTimeout(loop, cfg.pollMs);
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    clearTimeout(timer);
    log(`${sig} received, stopping`);
  });
}
loop();
