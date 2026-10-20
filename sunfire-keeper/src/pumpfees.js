// Pump.fun creator fee sharing. Once sharing is set up for a token, its
// creator fees collect in a vault owned by the token's sharing config, and
// anyone can call distribute_creator_fees to pay every shareholder its share.
// After graduation, PumpSwap keeps the creator fees as wSOL in its own vault;
// transfer_creator_fees_to_pump moves them back first. Since October 2026,
// pump.fun's newer trades (buy_v3 / sell_v3) leave the creator fee on the
// bonding curve instead, and distribute refuses to run until
// sweep_creator_fee has moved it to the vault. All are permissionless.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ata, ATA_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "./program.js";

export const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

// Discriminators from pump.json and pump_amm.json in pump-fun/pump-public-docs.
const DISTRIBUTE_CREATOR_FEES = Buffer.from([165, 114, 103, 0, 121, 206, 247, 81]);
const TRANSFER_CREATOR_FEES_TO_PUMP = Buffer.from([139, 52, 134, 85, 228, 229, 108, 241]);
const SWEEP_CREATOR_FEE = Buffer.from([32, 246, 191, 52, 8, 201, 73, 186]);

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });

export function feeAccounts(mint) {
  const sharingConfig = pda([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEES);
  const ammVaultAuthority = pda([Buffer.from("creator_vault"), sharingConfig.toBuffer()], PUMP_AMM);
  return {
    sharingConfig,
    bondingCurve: pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP),
    creatorVault: pda([Buffer.from("creator-vault"), sharingConfig.toBuffer()], PUMP),
    ammVaultAuthority,
    ammVaultAta: ata(ammVaultAuthority, WSOL_MINT, TOKEN_PROGRAM),
  };
}

/**
 * Reads a SharingConfig account: bump, version, status, mint, admin,
 * admin_revoked, then a vec of (address, share_bps).
 */
export function decodeSharingConfig(data) {
  const buf = Buffer.from(data);
  const mint = new PublicKey(buf.subarray(11, 43));
  const admin = new PublicKey(buf.subarray(43, 75));
  const count = buf.readUInt32LE(76);
  const shareholders = [];
  for (let i = 0; i < count; i++) {
    const o = 80 + i * 34;
    shareholders.push({ address: new PublicKey(buf.subarray(o, o + 32)), shareBps: buf.readUInt16LE(o + 32) });
  }
  return { mint, admin, shareholders };
}

/** BondingCurve.creator_fee: the creator fee waiting on the curve, 0 on accounts older than the field. */
export function waitingCreatorFee(curveData) {
  return curveData?.length >= 133 ? Buffer.from(curveData).readBigUInt64LE(125) : 0n;
}

/**
 * Moves the creator fee waiting on the bonding curve to the creator vault.
 * Does nothing when none waits; the payer only covers rent top-ups.
 */
export function sweepCreatorFeeIx(mint, payer) {
  const a = feeAccounts(mint);
  return new TransactionInstruction({
    programId: PUMP,
    data: SWEEP_CREATOR_FEE,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, ro(pda([Buffer.from("global")], PUMP)), ro(mint),
      ro(WSOL_MINT), ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SystemProgram.programId),
      // The two wSOL accounts are only used by token-paired coins, but must be passed.
      rw(a.bondingCurve), rw(ata(a.bondingCurve, WSOL_MINT, TOKEN_PROGRAM)), rw(a.creatorVault), rw(ata(a.creatorVault, WSOL_MINT, TOKEN_PROGRAM)),
      ro(pda([Buffer.from("__event_authority")], PUMP)), ro(PUMP),
    ],
  });
}

export function distributeIx(mint, shareholders) {
  const a = feeAccounts(mint);
  return new TransactionInstruction({
    programId: PUMP,
    data: DISTRIBUTE_CREATOR_FEES,
    keys: [
      ro(mint), ro(a.bondingCurve), ro(a.sharingConfig), rw(a.creatorVault), ro(SystemProgram.programId),
      ro(pda([Buffer.from("__event_authority")], PUMP)), ro(PUMP),
      ...shareholders.map((s) => rw(s.address)),
    ],
  });
}

export function transferAmmFeesIx(mint) {
  const a = feeAccounts(mint);
  return new TransactionInstruction({
    programId: PUMP_AMM,
    data: TRANSFER_CREATOR_FEES_TO_PUMP,
    keys: [
      ro(WSOL_MINT), ro(TOKEN_PROGRAM), ro(SystemProgram.programId), ro(ATA_PROGRAM),
      ro(a.sharingConfig), rw(a.ammVaultAuthority), rw(a.ammVaultAta), rw(a.creatorVault),
      ro(pda([Buffer.from("__event_authority")], PUMP_AMM)), ro(PUMP_AMM),
    ],
  });
}
