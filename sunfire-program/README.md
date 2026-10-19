# SunFire : le programme Solana

Programme Anchor qui partage les fees de $SFIRE entre le wallet dev et un coffre de burn. Il dépense ensuite une part aléatoire de ce coffre pour racheter du $SFIRE et le brûler, à chaque éruption M ou X et à chaque tempête G4 ou plus.

**État :** testé sur devnet, sur validateur local et sur une copie locale du mainnet (vrais programmes Jupiter, pump.fun et PumpSwap, vrais tokens pump.fun) : `arm`, achat via Jupiter puis burn fonctionnent, avant et après graduation. Il n'a jamais acheté avec de l'argent réel. Voir « Avant le mainnet » plus bas.

## Comment ça marche

| Instruction | Qui peut l'appeler | Ce qu'elle fait |
|---|---|---|
| `initialize` | l'autorité de mise à jour du programme, une fois | Crée la config : wallet dev, part dev (max 50 %), keeper, mint $SFIRE. Personne d'autre ne peut l'appeler, donc personne ne peut te devancer après le déploiement |
| `distribute` | tout le monde | Vide le coffre des fees : `dev_bps` vers ton wallet, le reste vers le coffre de burn |
| `arm(tier, reading, observed_at)` | le keeper uniquement | Reçoit la mesure NOAA et son heure, vérifie le seuil et que l'événement est nouveau, tire la part au hasard et fixe le budget |
| `execute` | le keeper uniquement | Achète du $SFIRE via Jupiter avec ce budget au maximum, puis brûle tout ce qui a été acheté |
| `disarm` | le keeper ou l'admin | Annule un burn armé qui ne peut pas être exécuté (pas de route Jupiter, pas de liquidité). Aucun SOL ne bouge : le budget reste dans le coffre de burn, et l'événement reste compté |
| `sync(xray, kp, observed_at)` | le keeper uniquement | Réarme les déclencheurs quand le Soleil redevient calme |
| `update_settings` | toi, jusqu'au renoncement | Change le wallet dev, la part dev ou le keeper |
| `renounce` | toi, une fois | Supprime l'admin pour toujours. Plus rien ne peut être modifié |

**Paliers** (`programs/sunfire/src/math.rs`) :

| Événement | Seuil | Part du coffre de burn |
|---|---|---|
| `0` M | flux ≥ 1e-5 W/m² | 1 à 5 % |
| `1` X | flux ≥ 1e-4 W/m² | 10 à 25 % |
| `2` Storm | Kp ≥ 8 (G4–G5) | 30 à 50 % |

**Anti-doublon :** une même éruption déclenche le palier M une fois et le palier X une fois. Une M qui devient X déclenche donc les deux. Tout se réarme quand le flux repasse sous M, ou sous Kp 8 pour les tempêtes.

**Pourquoi deux étapes (`arm` puis `execute`) :** le montant est fixé sur la blockchain au moment de `arm`. Le keeper doit le connaître pour demander une route à Jupiter. Il lit donc `pending_budget` après `arm`, puis appelle `execute` avec la route.

**Pourquoi `execute` est réservé au keeper :** c'est l'appelant qui choisit `min_out`. Si n'importe qui pouvait appeler `execute`, quelqu'un pourrait mettre 0 et se sandwicher lui-même pour siphonner le coffre. Le keeper calcule `min_out` à partir du devis Jupiter avec une marge de slippage.

**Garde-fous dans `execute` :** le swap ne peut pas dépenser plus que le budget fixé, en comptant ensemble le wSOL (PumpSwap) et les SOL natifs (courbe pump.fun, qui prend ses frais en plus de l'achat). Il doit rapporter au moins `min_out` tokens. Le seul programme appelé est Jupiter v6. Le mint $SFIRE peut être en SPL Token ou en Token-2022 (les tokens pump.fun récents sont en Token-2022).

## Les données NOAA

Le programme ne lit pas la NOAA lui-même : une blockchain ne peut pas lire un site web. C'est le keeper (`sunfire-keeper/`) qui lit le flux X des satellites GOES et l'indice Kp sur services.swpc.noaa.gov, puis les envoie à `arm` et `sync` avec l'heure de la mesure NOAA :
- flux X en W/m² × 1e9 (une M1.0 vaut 10 000) ;
- Kp × 100 (Kp 8 vaut 800).

Le programme refuse une mesure de plus de 6 h ou datée dans le futur, et toute signature autre que celle du keeper. Chaque mesure est publiée dans les événements `BurnArmed` et `Synced`, donc n'importe qui peut la comparer avec les archives de la NOAA. Les holders font confiance au keeper pour rapporter des mesures exactes.

Switchboard, prévu au départ, n'est plus utilisable : ses oracles Solana ne publient plus de mises à jour.

## Les fees

Le coffre des fees est une adresse du programme (PDA `fee_vault`). Deux cas :
- **La plateforme de lancement permet de choisir l'adresse qui reçoit les fees créateur :** tu mets le `fee_vault`, et tout est automatique.
- **Elle ne le permet pas (les fees arrivent sur ton wallet) :** tu envoies la part du coffre à la main. Les holders doivent alors te faire confiance sur ce point, donc annonce-le clairement.

## Tests

| Fichier | Ce qu'il teste |
|---|---|
| `tests/devnet-smoke.cjs` | `initialize`, `update_settings`, `distribute`, gardes de `arm`, `renounce` |
| `tests/local-arm.cjs` | `arm`, `sync`, `disarm` et le tirage des budgets |
| `tests/fork/` | `execute` de bout en bout sur une copie locale du mainnet : `prepare.cjs` liste les comptes à cloner pour une route Jupiter, `run.cjs` fait initialize, distribute, arm, execute et vérifie le burn |

Ils utilisent `@solana/web3.js` directement, sans IDL.

## Déployer

```bash
# 1. Outils : Rust, Solana CLI (Agave) et Anchor 0.32
# 2. Clé du programme, puis mettre l'adresse dans declare_id! (lib.rs) et Anchor.toml
anchor keys sync
anchor build
anchor deploy --provider.cluster devnet
# 3. Appeler initialize avec ton wallet dev, dev_bps = 5000 (50 %) et l'adresse du keeper
```

## Avant le mainnet

1. **Premier burn réel** avec un petit montant (environ 0,01 SOL) juste après le déploiement, avant d'annoncer le token.
2. **Keeper :** si sa clé fuitait, l'attaquant pourrait déclencher des burns au mauvais moment ou sandwicher un achat. Il ne peut pas sortir de SOL du coffre autrement que par un achat suivi d'un burn.
3. **Hasard :** la v1 utilise le dernier hash de slot. Le keeper peut choisir son moment pour viser un montant plus haut ou plus bas dans la fourchette.
4. Choix actuel : l'admin et l'autorité de mise à jour sont **conservés** pour pouvoir corriger un problème. Si un jour tu veux rendre le programme intouchable : `renounce`, puis `solana program set-upgrade-authority <PROGRAM_ID> --final`.
