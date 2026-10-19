// Cancels the armed burn when `execute` cannot go through. Signed by the
// keeper or the admin. No SOL leaves the burn vault.
//
//   RPC_URL=https://api.mainnet-beta.solana.com PROGRAM_ID=<program id> \
//   KEYPAIR=path/to/keeper-or-admin.json node scripts/disarm.cjs
//
// Needs @solana/web3.js.

const crypto = require("crypto");
const fs = require("fs");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const programId = new PublicKey(process.env.PROGRAM_ID);
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR, "utf8"))));
const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];

const ix = new TransactionInstruction({
  programId,
  data: crypto.createHash("sha256").update("global:disarm").digest().subarray(0, 8),
  keys: [
    { pubkey: signer.publicKey, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: true },
  ],
});

sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer])
  .then((sig) => console.log(`Burn disarmed: ${sig}`))
  .catch((e) => {
    const logs = (e.logs || []).join("\n");
    if (logs.includes("NothingArmed")) console.log("No burn is armed, nothing to do.");
    else if (logs.includes("NotKeeper")) console.log("This wallet is neither the keeper nor the admin.");
    else console.error(e);
    process.exit(1);
  });
