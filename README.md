# SunFire ($SFIRE)

A Solana token whose supply is governed by the Sun. Solar flares and geomagnetic storms recorded by NOAA's GOES satellites trigger buybacks and burns on-chain.

| Folder | Contents |
|---|---|
| `sunfire-site/` | Website: live NASA SDO viewer and NOAA space-weather data. |
| `sunfire-program/` | Anchor program: fee split, buyback and burn triggered by NOAA readings. Optional: the bot also runs without it. See its README. |
| `sunfire-keeper/` | Bot: reads NOAA, buys $SFIRE through Jupiter and burns it on every M/X flare and G4+ storm. Bot-only or with the program. Runs on Railway, dry run by default. |
