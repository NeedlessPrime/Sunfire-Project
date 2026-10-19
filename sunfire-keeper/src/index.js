import { makeAlert } from "./alert.js";
import { Chain } from "./chain.js";
import { loadConfig } from "./config.js";
import { buildSwap } from "./jupiter.js";
import { Keeper } from "./keeper.js";
import { readNoaa } from "./noaa.js";

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const cfg = loadConfig();
const chain = new Chain({ rpcUrl: cfg.rpcUrl, programId: cfg.programId, signer: cfg.keeper, dryRun: cfg.dryRun, log });
const keeper = new Keeper({ cfg, chain, readNoaa: () => readNoaa(), buildSwap, alert: makeAlert(cfg.alertWebhook, { log }), log });

log(`SunFire keeper ${cfg.dryRun ? "in DRY RUN (simulates only)" : "LIVE"}`);
log(`program ${cfg.programId.toBase58()}, keeper ${cfg.keeper.publicKey.toBase58()}, every ${cfg.pollMs / 1000}s`);

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
