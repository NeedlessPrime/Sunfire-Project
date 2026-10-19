// Asks the real Jupiter API for a SOL -> token route paid by the burn vault
// PDA, and returns everything a local mainnet fork needs to replay it.
// Used by prepare.cjs (before the validator starts) and run.cjs (after arm).

const {
  PublicKey, TransactionInstruction,
} = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");

const JUP_API = process.env.JUP_API || "https://lite-api.jup.ag/swap/v1";
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

async function getJson(url, init) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res.json();
    const body = await res.text();
    if (attempt >= 4 || res.status < 500 && res.status !== 429) throw new Error(`${res.status} ${url}: ${body.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

/**
 * @param {object} p
 * @param {PublicKey} p.burnVault  PDA that owns the wSOL and token accounts
 * @param {PublicKey} p.mint       token to buy
 * @param {PublicKey} p.mintProgram SPL Token or Token-2022
 * @param {bigint|number} p.lamports amount of wSOL to spend
 * @param {number} p.slippageBps
 * @param {string} [p.dexes]       restrict the route (comma separated Jupiter labels)
 */
async function jupiterRoute({ burnVault, mint, mintProgram, lamports, slippageBps, dexes }) {
  const q = new URLSearchParams({
    inputMint: WSOL.toBase58(), outputMint: mint.toBase58(), amount: String(lamports),
    slippageBps: String(slippageBps), onlyDirectRoutes: "true", maxAccounts: "40",
  });
  if (dexes) q.set("dexes", dexes);
  const quote = await getJson(`${JUP_API}/quote?${q}`);

  const vaultWsol = getAssociatedTokenAddressSync(WSOL, burnVault, true, TOKEN_PROGRAM_ID);
  const vaultToken = getAssociatedTokenAddressSync(mint, burnVault, true, mintProgram);
  const swap = await getJson(`${JUP_API}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: burnVault.toBase58(),
      wrapAndUnwrapSol: false,
      useSharedAccounts: false,
      destinationTokenAccount: vaultToken.toBase58(),
      dynamicComputeUnitLimit: false,
      skipUserAccountsRpcCalls: true,
    }),
  });
  if (swap.error) throw new Error(`swap-instructions: ${swap.error}`);

  const si = swap.swapInstruction;
  const ix = new TransactionInstruction({
    programId: new PublicKey(si.programId),
    data: Buffer.from(si.data, "base64"),
    keys: si.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  });
  return {
    quote, ix, vaultWsol, vaultToken,
    setup: (swap.setupInstructions || []).map((s) => ({ programId: s.programId, accounts: s.accounts.length })),
    other: (swap.otherInstructions || []).map((s) => s.programId),
    luts: swap.addressLookupTableAddresses || [],
  };
}

module.exports = { jupiterRoute, WSOL };
