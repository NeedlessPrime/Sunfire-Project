import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Reads the keeper settings from environment variables. */
export function loadConfig(env = process.env) {
  const dryRun = env.DRY_RUN !== "false";
  // With a program the bot arms and executes burns through it. Without one
  // (bot-only mode) it buys and burns from its own wallet.
  const mode = env.PROGRAM_ID ? "program" : "wallet";
  if (mode === "wallet" && !env.SFIRE_MINT) throw new Error("Set SFIRE_MINT (bot-only mode) or PROGRAM_ID");
  if (!env.KEEPER_SECRET_KEY && !dryRun) throw new Error("KEEPER_SECRET_KEY is required when DRY_RUN=false");
  // A dry run only simulates, so a throwaway key is enough to try the bot.
  const keeper = env.KEEPER_SECRET_KEY ? parseSecretKey(env.KEEPER_SECRET_KEY) : Keypair.generate();
  const feeShareWallet = env.FEE_SHARE_WALLET ? parseAddress(env.FEE_SHARE_WALLET, "FEE_SHARE_WALLET") : null;
  if (feeShareWallet?.equals(keeper.publicKey)) throw new Error("FEE_SHARE_WALLET must be another wallet than the bot's");
  const feeSharePct = num(env.FEE_SHARE_PERCENT, 50);
  if (feeSharePct > 100) throw new Error(`FEE_SHARE_PERCENT must be between 0 and 100, got ${feeSharePct}`);

  return {
    rpcUrl: env.RPC_URL || "https://api.mainnet-beta.solana.com",
    mode,
    programId: env.PROGRAM_ID ? new PublicKey(env.PROGRAM_ID) : null,
    sfireMint: env.SFIRE_MINT ? new PublicKey(env.SFIRE_MINT) : null,
    keeper,
    dryRun,
    pollMs: num(env.POLL_SECONDS, 60) * 1000,
    slippageBps: num(env.SLIPPAGE_BPS, 300),
    // Pump.fun charges its fee in SOL on top of the swap, so only part of
    // the armed budget goes into the swap itself.
    budgetUseBps: num(env.BUDGET_USE_BPS, 9500),
    disarmAfterMs: num(env.DISARM_AFTER_MINUTES, 60) * 60_000,
    distributeMinLamports: Math.round(num(env.DISTRIBUTE_MIN_SOL, 0.05) * 1e9),
    jupiterApi: (env.JUPITER_API || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, ""),
    jupiterApiKey: env.JUPITER_API_KEY || "",
    // Optional: restrict buybacks to these Jupiter DEX labels (comma separated).
    jupiterDexes: env.JUPITER_DEXES || "",
    alertWebhook: env.ALERT_WEBHOOK_URL || "",
    // Bot-only mode.
    reserveLamports: lamports(num(env.RESERVE_SOL, 0.02)),
    minBuyLamports: lamports(num(env.MIN_BUY_SOL, 0.002)),
    maxEventAgeSec: num(env.MAX_EVENT_AGE_HOURS, 6) * 3600,
    feeCrankMs: num(env.FEE_CRANK_MINUTES, 30) * 60_000,
    crankMinLamports: lamports(num(env.CRANK_MIN_SOL, 0.01)),
    maxPriceImpactPct: num(env.MAX_PRICE_IMPACT_PCT, 15),
    // Optional: all creator fees reach the bot, which forwards this share of
    // every payout to FEE_SHARE_WALLET.
    feeShareWallet,
    feeShareBps: Math.round(feeSharePct * 100),
    feeShareLookbackSec: num(env.FEE_SHARE_LOOKBACK_HOURS, 72) * 3600,
  };
}

function parseAddress(value, name) {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new Error(`${name} is not a valid Solana address`);
  }
}

/** Accepts a base58 secret key or the JSON byte array written by solana-keygen. */
export function parseSecretKey(value) {
  try {
    const s = value.trim();
    const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
    return Keypair.fromSecretKey(bytes);
  } catch {
    // Never echo the parser's message: it can quote part of the key.
    throw new Error("KEEPER_SECRET_KEY is not a valid secret key (base58 or the solana-keygen JSON array)");
  }
}

const lamports = (solAmount) => BigInt(Math.round(solAmount * 1e9));

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number: ${value}`);
  return n;
}
