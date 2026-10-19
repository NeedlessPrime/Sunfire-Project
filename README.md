# SunFire ($SFIRE)

A Solana token whose supply is governed by the Sun. Solar flares and geomagnetic storms recorded by NOAA's GOES satellites trigger buybacks and burns on-chain.

| Folder | Contents |
|---|---|
| `sunfire-site/` | Website: live NASA SDO viewer and NOAA space-weather data. |
| `sunfire-program/` | Anchor program: fee split, oracle-gated buyback and burn. Not yet deployed or audited. See its README. |
| `sunfire-keeper/` | Keeper bot: reads NOAA, arms and executes burns through Jupiter. Runs on Railway, dry run by default. |
