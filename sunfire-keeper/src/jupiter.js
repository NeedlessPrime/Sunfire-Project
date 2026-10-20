import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { JUPITER_V6, WSOL_MINT } from "./program.js";

/** The tiny buy (0.001 SOL) a buyback's rate is compared with to measure its price impact. */
const REF_LAMPORTS = 1_000_000n;

/**
 * Asks Jupiter for a wSOL → $SFIRE route paid from the burn vault.
 *
 * The program wraps the budget into the vault's wSOL account itself, so the
 * route must not wrap or unwrap SOL. The keeper pays any account rent the
 * route needs (`payer`), never the vault.
 */
export async function buildSwap({ api, apiKey = "", fetchFn = fetch, amount, sfireMint, burnVault, vaultSfire, payer, slippageBps }) {
  if (amount <= 0n) throw new Error("Swap amount must be positive");
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const params = new URLSearchParams({
    inputMint: WSOL_MINT.toBase58(),
    outputMint: sfireMint.toBase58(),
    amount: amount.toString(),
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
  });
  const quoteRes = await fetchFn(`${api}/quote?${params}`, { headers });
  if (!quoteRes.ok) throw new Error(`Jupiter quote ${quoteRes.status}: ${await quoteRes.text()}`);
  const quote = await quoteRes.json();

  const swapRes = await fetchFn(`${api}/swap-instructions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: burnVault.toBase58(),
      payer: payer.toBase58(),
      wrapAndUnwrapSol: false,
      destinationTokenAccount: vaultSfire.toBase58(),
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap-instructions ${swapRes.status}: ${await swapRes.text()}`);
  const body = await swapRes.json();
  if (body.error) throw new Error(`Jupiter: ${body.error}`);

  const swap = toIx(body.swapInstruction);
  if (!swap.programId.equals(JUPITER_V6)) throw new Error(`Unexpected swap program ${swap.programId.toBase58()}`);

  return {
    inAmount: BigInt(quote.inAmount),
    outAmount: BigInt(quote.outAmount),
    // Jupiter's minimum after slippage. The program refuses to burn less.
    minOut: BigInt(quote.otherAmountThreshold),
    // Jupiter gives the price impact as a fraction (0.05 = 5 %).
    priceImpactPct: Number(quote.priceImpactPct ?? 0) * 100,
    // The vault is a PDA: it cannot sign the outer transaction. The program
    // signs for it with invoke_signed.
    remaining: swap.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(burnVault) ? false : k.isSigner })),
    data: swap.data,
    setup: (body.setupInstructions ?? []).map(toIx),
    computeBudget: (body.computeBudgetInstructions ?? []).map(toIx),
    lookupTables: (body.addressLookupTableAddresses ?? []).map((a) => new PublicKey(a)),
  };
}

/**
 * Bot-only mode: a SOL → $SFIRE route bought by the bot wallet itself, like
 * any wallet. Jupiter wraps the SOL and unwraps what is left.
 */
export async function buildWalletSwap({ api, apiKey = "", fetchFn = fetch, amount, sfireMint, user, slippageBps, dexes = "" }) {
  if (amount <= 0n) throw new Error("Swap amount must be positive");
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const params = new URLSearchParams({
    inputMint: WSOL_MINT.toBase58(),
    outputMint: sfireMint.toBase58(),
    amount: amount.toString(),
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
  });
  if (dexes) params.set("dexes", dexes);
  const quoteFor = async (lamports) => {
    params.set("amount", lamports.toString());
    const res = await fetchFn(`${api}/quote?${params}`, { headers });
    if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const quote = await quoteFor(amount);
  // Jupiter reports no price impact on pump.fun's bonding curve, so the bot
  // measures it: how much worse the rate is than for a tiny buy.
  const ref = await quoteFor(REF_LAMPORTS);
  const rate = (q, lamports) => Number(q.outAmount) / Number(lamports);
  const priceImpactPct = Math.max(0, (1 - rate(quote, amount) / rate(ref, REF_LAMPORTS)) * 100);

  const swapRes = await fetchFn(`${api}/swap-instructions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap-instructions ${swapRes.status}: ${await swapRes.text()}`);
  const body = await swapRes.json();
  if (body.error) throw new Error(`Jupiter: ${body.error}`);

  const swap = toIx(body.swapInstruction);
  if (!swap.programId.equals(JUPITER_V6)) throw new Error(`Unexpected swap program ${swap.programId.toBase58()}`);
  return {
    inAmount: BigInt(quote.inAmount),
    outAmount: BigInt(quote.outAmount),
    minOut: BigInt(quote.otherAmountThreshold),
    priceImpactPct,
    instructions: [
      ...(body.computeBudgetInstructions ?? []).map(toIx),
      ...(body.setupInstructions ?? []).map(toIx),
      swap,
      ...(body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : []),
    ],
    lookupTables: (body.addressLookupTableAddresses ?? []).map((a) => new PublicKey(a)),
  };
}

function toIx(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}
