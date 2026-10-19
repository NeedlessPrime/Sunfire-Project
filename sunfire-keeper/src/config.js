import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Reads the keeper settings from environment variables. */
export function loadConfig(env = process.env) {
  const dryRun = env.DRY_RUN !== "false";
  if (!env.PROGRAM_ID) throw new Error("PROGRAM_ID is required");
  if (!env.KEEPER_SECRET_KEY && !dryRun) throw new Error("KEEPER_SECRET_KEY is required when DRY_RUN=false");

  return {
    rpcUrl: env.RPC_URL || "https://api.mainnet-beta.solana.com",
    programId: new PublicKey(env.PROGRAM_ID),
    // A dry run only simulates, so a throwaway key is enough to try the bot.
    keeper: env.KEEPER_SECRET_KEY ? parseSecretKey(env.KEEPER_SECRET_KEY) : Keypair.generate(),
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
    alertWebhook: env.ALERT_WEBHOOK_URL || "",
  };
}

/** Accepts a base58 secret key or the JSON byte array written by solana-keygen. */
export function parseSecretKey(value) {
  const s = value.trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number: ${value}`);
  return n;
}
