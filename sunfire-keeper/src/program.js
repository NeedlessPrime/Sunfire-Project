import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, TransactionInstruction } from "@solana/web3.js";

export const JUPITER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b8VTt3jajUSedEn3AfGBMh8tVwUJ");

/** Lamports the program keeps in each vault (VAULT_FLOOR in lib.rs). */
export const VAULT_FLOOR = 1_000_000n;

// The layouts below must match programs/sunfire/src/lib.rs.
// test/contract.test.js reads lib.rs and fails if they drift apart.

export const CONFIG_FIELDS = [
  ["admin", "pubkey"],
  ["keeper", "pubkey"],
  ["dev_wallet", "pubkey"],
  ["dev_bps", "u16"],
  ["sfire_mint", "pubkey"],
  ["m_fired", "bool"],
  ["x_fired", "bool"],
  ["storm_fired", "bool"],
  ["pending_budget", "u64"],
  ["pending_tier", "u8"],
  ["events", "u64"],
  ["total_burned", "u64"],
  ["total_sol_spent", "u64"],
  ["bump", "u8"],
  ["fee_vault_bump", "u8"],
  ["burn_vault_bump", "u8"],
];

// Accounts in order. Suffix ":s" marks a signer, ":w" a writable account.
export const INSTRUCTIONS = {
  arm: {
    args: [["tier", "u8"], ["reading", "u64"], ["observed_at", "i64"]],
    accounts: ["keeper:s", "config:w", "burn_vault", "slot_hashes"],
  },
  sync: {
    args: [["xray", "u64"], ["kp", "u64"], ["observed_at", "i64"]],
    accounts: ["keeper:s", "config:w"],
  },
  disarm: {
    args: [],
    accounts: ["authority:s", "config:w"],
  },
  distribute: {
    args: [],
    accounts: ["config", "fee_vault:w", "burn_vault:w", "dev_wallet:w", "system_program"],
  },
  execute: {
    args: [["jupiter_data", "bytes"], ["min_out", "u64"]],
    accounts: [
      "executor:s", "config:w", "burn_vault:w", "vault_wsol:w", "vault_sfire:w", "sfire_mint:w",
      "wsol_mint", "jupiter_program", "token_program", "sfire_token_program", "system_program",
    ],
  },
};

export function pdas(programId) {
  const find = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
  return { config: find("config"), feeVault: find("fee_vault"), burnVault: find("burn_vault") };
}

export function ata(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/** Creates `owner`'s associated token account if it does not exist yet. */
export function createAtaIdempotent(payer, owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

export const discriminator = (kind, name) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);

/**
 * Builds a program instruction from INSTRUCTIONS.
 * `accounts` maps account names to public keys, `args` maps arg names to values.
 */
export function buildIx(programId, name, accounts, args = {}, remaining = []) {
  const spec = INSTRUCTIONS[name];
  if (!spec) throw new Error(`Unknown instruction ${name}`);
  const keys = spec.accounts.map((entry) => {
    const [key, flags = ""] = entry.split(":");
    const pubkey = accounts[key];
    if (!pubkey) throw new Error(`${name}: missing account ${key}`);
    return { pubkey, isSigner: flags.includes("s"), isWritable: flags.includes("w") };
  });
  const data = Buffer.concat([discriminator("global", name), ...spec.args.map(([arg, type]) => encode(type, args[arg], `${name}.${arg}`))]);
  return new TransactionInstruction({ programId, keys: [...keys, ...remaining], data });
}

/** Common accounts every instruction may need, keyed by their lib.rs names. */
export function knownAccounts(programId, state, signer) {
  const p = pdas(programId);
  return {
    keeper: signer,
    authority: signer,
    executor: signer,
    config: p.config,
    fee_vault: p.feeVault,
    burn_vault: p.burnVault,
    dev_wallet: state?.devWallet,
    sfire_mint: state?.sfireMint,
    slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY,
    wsol_mint: WSOL_MINT,
    jupiter_program: JUPITER_V6,
    token_program: TOKEN_PROGRAM,
    system_program: SystemProgram.programId,
  };
}

export function decodeConfig(data) {
  const buf = Buffer.from(data);
  if (!buf.subarray(0, 8).equals(discriminator("account", "Config"))) throw new Error("Not a SunFire config account");
  let o = 8;
  const raw = {};
  for (const [name, type] of CONFIG_FIELDS) {
    switch (type) {
      case "pubkey": raw[name] = new PublicKey(buf.subarray(o, o + 32)); o += 32; break;
      case "u64": raw[name] = buf.readBigUInt64LE(o); o += 8; break;
      case "u16": raw[name] = buf.readUInt16LE(o); o += 2; break;
      case "u8": raw[name] = buf.readUInt8(o); o += 1; break;
      case "bool": raw[name] = buf.readUInt8(o) === 1; o += 1; break;
      default: throw new Error(`Unsupported field type ${type}`);
    }
  }
  return {
    admin: raw.admin,
    keeper: raw.keeper,
    devWallet: raw.dev_wallet,
    devBps: raw.dev_bps,
    sfireMint: raw.sfire_mint,
    mFired: raw.m_fired,
    xFired: raw.x_fired,
    stormFired: raw.storm_fired,
    pendingBudget: raw.pending_budget,
    pendingTier: raw.pending_tier,
    events: raw.events,
    totalBurned: raw.total_burned,
    totalSolSpent: raw.total_sol_spent,
  };
}

function encode(type, value, label) {
  if (value === undefined || value === null) throw new Error(`Missing argument ${label}`);
  switch (type) {
    case "u8": return Buffer.from([Number(value)]);
    case "u16": { const b = Buffer.alloc(2); b.writeUInt16LE(Number(value)); return b; }
    case "u64": { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
    case "i64": { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
    case "bool": return Buffer.from([value ? 1 : 0]);
    case "pubkey": return new PublicKey(value).toBuffer();
    case "bytes": {
      const data = Buffer.from(value);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(data.length);
      return Buffer.concat([len, data]);
    }
    default: throw new Error(`Unsupported arg type ${type}`);
  }
}
