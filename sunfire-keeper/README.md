# SunFire keeper

The bot behind SunFire burns. It runs in one of two modes:

- **Bot-only mode** (`SFIRE_MINT` set, no `PROGRAM_ID`): no program is deployed. Pump.fun fee sharing pays the creator fees to the bot wallet, the bot forwards the team's share, and it buys and burns $SFIRE from that wallet on every solar event.
- **Program mode** (`PROGRAM_ID` set): the bot drives the SunFire program in `sunfire-program/`.

Both start in dry-run mode: every transaction is simulated, nothing is sent.

## Bot-only mode

Every minute the bot:

1. Pays out the token's shared creator fees (`distribute_creator_fees`, and `transfer_creator_fees_to_pump` after graduation) once they reach `CRANK_MIN_SOL`, at most every `FEE_CRANK_MINUTES`. Anyone can call these; the bot pays the transaction fee.
2. With `FEE_SHARE_WALLET` set, forwards `FEE_SHARE_PERCENT` of every payout that reached it to that wallet, whoever cranked the payout. A share is always paid before any buyback, and in the tick that cranked a payout the bot waits instead of buying.
3. Reads NOAA's flare lists and planetary Kp. Every M or X flare and every G4+ storm (Kp ≥ 8) that started within `MAX_EVENT_AGE_HOURS` is an event, named after its NOAA start time.
4. For the oldest event not yet bought, spends a random share of its balance above `RESERVE_SOL`: 1–5 % on an M flare, 10–25 % on an X flare, 30–50 % on a storm. It buys $SFIRE through Jupiter and burns everything bought.

Each buyback carries a public memo, for example `SunFire buyback key=M-20261019T1300 event="M2.0 begin 2026-10-19T13:00:00Z" share=4.77% sol=0.0467`, and each burn a `SunFire burn key=… amount=…` memo. The bot reads its own memos back, so an event is never bought twice, even after a restart. Anyone can follow the bot wallet on an explorer and compare each event with NOAA.

Each fee share carries a `SunFire fee share for=<payout signature> sol=…` memo. The bot finds payouts in its own history: successful transactions that touched the token's creator vault and left the bot richer, including payouts someone else cranked. A payout whose share memo is already on-chain is never paid again. If the bot cannot pay a share, it alerts once and pauses buybacks until it can, so nothing owed is ever spent on a burn. Shares below 0.0001 SOL stay with the bot, and payouts older than `FEE_SHARE_LOOKBACK_HOURS` are not looked at.

Holders trust that this wallet is only used for burns: unlike the program, nothing on-chain enforces it.

What the bot checks before it signs a buyback, since it signs instructions returned by Jupiter's API:
- only the Compute Budget, System, SPL Token, Associated Token Account and Jupiter v6 programs appear;
- SOL only moves into the bot's own wSOL account, and that account can only be closed back to the bot;
- a simulation shows at most the buyback amount plus 0.01 SOL of fees and rent leaving the wallet, and at least Jupiter's minimum output arriving in the bot's own $SFIRE account.

Only memos from transactions the bot paid for count when it checks which events were already bought or which payouts were already shared, so nobody can block a burn or a fee share by sending the wallet a fake memo.

Use a dedicated wallet for the bot, never one that holds anything else.

Fee setup, either:
- **Fee share (recommended):** make the bot wallet the only pump.fun fee shareholder (100 %) and set `FEE_SHARE_WALLET` to the team wallet. The bot warns in its logs if it gets less than 100 % while the fee share is on, since the team's share would then be taken twice.
- **Pump.fun split:** make the bot wallet one of several shareholders (for example 50 % team wallet, 50 % bot wallet) and leave `FEE_SHARE_WALLET` empty.

| Variable | Default | |
|---|---|---|
| `SFIRE_MINT` | required | The token's mint address |
| `KEEPER_SECRET_KEY` | required when live | Bot wallet key, base58 or the JSON array from `solana-keygen` |
| `RESERVE_SOL` | `0.02` | Kept for transaction fees, never spent on buybacks |
| `MIN_BUY_SOL` | `0.002` | Smaller buybacks are skipped |
| `MAX_EVENT_AGE_HOURS` | `6` | Older events are ignored |
| `FEE_CRANK_MINUTES` | `30` | `0` turns the fee payout off |
| `CRANK_MIN_SOL` | `0.01` | |
| `MAX_PRICE_IMPACT_PCT` | `5` | A buyback with a higher price impact waits for a later tick |
| `FEE_SHARE_WALLET` | | Optional: team wallet that receives `FEE_SHARE_PERCENT` of every creator fee payout |
| `FEE_SHARE_PERCENT` | `50` | |
| `FEE_SHARE_LOOKBACK_HOURS` | `72` | How far back the bot looks for payouts to share, for example after downtime |
| `JUPITER_DEXES` | | Optional: restrict buybacks to these Jupiter DEX labels |

`DRY_RUN`, `RPC_URL`, `POLL_SECONDS`, `SLIPPAGE_BPS`, `JUPITER_API`, `JUPITER_API_KEY` and `ALERT_WEBHOOK_URL` work as in program mode below.

## Program mode

Every minute the bot:

1. Splits the fee vault once it holds more than `DISTRIBUTE_MIN_SOL`.
2. Reads the latest GOES X-ray flux and planetary Kp from NOAA SWPC.
3. Arms a burn on an M flare, X flare or G4+ storm, sending the NOAA reading and its time to the program.
4. Buys $SFIRE through Jupiter with the armed budget and burns it (`execute`).
5. Cancels a burn that still cannot execute after `DISARM_AFTER_MINUTES` (`disarm`), and alerts.
6. Re-arms the triggers once the Sun is calm again (`sync`).

It starts in dry-run mode: every transaction is simulated, nothing is sent.

## Run

```bash
npm install
SFIRE_MINT=<mint> npm start                # bot-only mode, dry run
PROGRAM_ID=<program id> npm start          # program mode, dry run
npm test
```

## Settings

| Variable | Default | |
|---|---|---|
| `PROGRAM_ID` | required | SunFire program address |
| `KEEPER_SECRET_KEY` | required when live | Keeper key, base58 or the JSON array from `solana-keygen`. Must match the keeper set in the program |
| `DRY_RUN` | `true` | Set to `false` to send transactions |
| `RPC_URL` | public mainnet RPC | A private RPC is recommended |
| `POLL_SECONDS` | `60` | |
| `SLIPPAGE_BPS` | `300` | Maximum slippage on a buyback |
| `BUDGET_USE_BPS` | `9500` | Share of the armed budget sent to the swap; the rest covers pump.fun fees |
| `DISARM_AFTER_MINUTES` | `60` | |
| `DISTRIBUTE_MIN_SOL` | `0.05` | |
| `JUPITER_API` | `https://lite-api.jup.ag/swap/v1` | |
| `JUPITER_API_KEY` | | Optional, for `api.jup.ag` |
| `ALERT_WEBHOOK_URL` | | Discord webhook for alerts and burns |

## Deploy on Railway

New service from this repository, Root Directory `sunfire-keeper`, then add the variables above. Keep `DRY_RUN=true` until the token is live (bot-only mode) or the program is initialized with this keeper's address (program mode). The bot wallet needs a little SOL for fees and account rent: its first buy also pays about 0.004 SOL for its token account and pump.fun's volume accumulator.
