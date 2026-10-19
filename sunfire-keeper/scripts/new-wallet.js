// Creates a fresh wallet for the bot. Paste the secret key into KEEPER_SECRET_KEY
// on Railway and share only the address.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const kp = Keypair.generate();
console.log(`Address (public):          ${kp.publicKey.toBase58()}`);
console.log(`KEEPER_SECRET_KEY (secret): ${bs58.encode(kp.secretKey)}`);
