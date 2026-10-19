# SunFire keeper

The bot that runs the SunFire program. Every minute it:

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
PROGRAM_ID=<program id> npm start          # dry run
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

New service from this repository, Root Directory `sunfire-keeper`, then add the variables above. Keep `DRY_RUN=true` until the program is live and initialized with this keeper's address. The keeper wallet needs a little SOL for fees and account rent.
