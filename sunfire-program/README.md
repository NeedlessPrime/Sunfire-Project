# SunFire : le programme Solana

Programme Anchor qui partage les fees de $SFIRE entre le wallet dev et un coffre de burn. Il dépense ensuite une part aléatoire de ce coffre pour racheter du $SFIRE et le brûler, à chaque éruption M ou X et à chaque tempête G4 ou plus.

**État :** le code compile, et les 9 tests de la logique (paliers, anti-doublon, hasard, partage des fees) passent. Il **n'a encore jamais tourné sur une blockchain**, même pas sur devnet, et il **n'est pas audité**. Ne pas le mettre sur mainnet avec de l'argent réel avant les étapes « Avant le mainnet » plus bas.

## Comment ça marche

| Instruction | Qui peut l'appeler | Ce qu'elle fait |
|---|---|---|
| `initialize` | l'autorité de mise à jour du programme, une fois | Crée la config : wallet dev, part dev (max 50 %), feeds Switchboard, keeper, mint $SFIRE. Personne d'autre ne peut l'appeler, donc personne ne peut te devancer après le déploiement |
| `distribute` | tout le monde | Vide le coffre des fees : `dev_bps` vers ton wallet, le reste vers le coffre de burn |
| `arm(tier)` | tout le monde | Lit l'oracle, vérifie que l'événement est réel et nouveau, tire la part au hasard et fixe le budget |
| `execute` | le keeper uniquement | Achète du $SFIRE via Jupiter avec exactement ce budget, puis brûle tout ce qui a été acheté |
| `disarm` | le keeper ou l'admin | Annule un burn armé qui ne peut pas être exécuté (pas de route Jupiter, pas de liquidité). Aucun SOL ne bouge : le budget reste dans le coffre de burn, et l'événement reste compté |
| `sync` | tout le monde | Réarme les déclencheurs quand le Soleil redevient calme |
| `update_settings` | toi, jusqu'au renoncement | Change le wallet dev, la part dev, le keeper ou les feeds |
| `renounce` | toi, une fois | Supprime l'admin pour toujours. Plus rien ne peut être modifié |

**Paliers** (`programs/sunfire/src/math.rs`) :

| Événement | Seuil | Part du coffre de burn |
|---|---|---|
| `0` M | flux ≥ 1e-5 W/m² | 1 à 5 % |
| `1` X | flux ≥ 1e-4 W/m² | 10 à 25 % |
| `2` Storm | Kp ≥ 8 (G4–G5) | 30 à 50 % |

**Anti-doublon :** une même éruption déclenche le palier M une fois et le palier X une fois. Une M qui devient X déclenche donc les deux. Tout se réarme quand le flux repasse sous M, ou sous Kp 8 pour les tempêtes.

**Pourquoi deux étapes (`arm` puis `execute`) :** le montant est fixé sur la blockchain au moment de `arm`. Le keeper doit le connaître pour demander une route à Jupiter. Il lit donc `pending_budget` après `arm`, puis appelle `execute` avec la route.

**Pourquoi `execute` est réservé au keeper :** c'est l'appelant qui choisit `min_out`. Si n'importe qui pouvait appeler `execute`, quelqu'un pourrait mettre 0 et se sandwicher lui-même pour siphonner le coffre. Le keeper (le bot GitHub Action) calcule `min_out` à partir du devis Jupiter avec une marge de slippage.

**Garde-fous dans `execute` :** le swap ne peut pas dépenser plus que le budget fixé. Il doit rapporter au moins `min_out` tokens. Il ne doit pas toucher aux SOL restants du coffre. Le seul programme appelé est Jupiter v6.

## Les fees

Le coffre des fees est une adresse du programme (PDA `fee_vault`). Deux cas :
- **La plateforme de lancement permet de choisir l'adresse qui reçoit les fees créateur :** tu mets le `fee_vault`, et tout est automatique et sans confiance.
- **Elle ne le permet pas (les fees arrivent sur ton wallet) :** tu envoies la part du coffre à la main. Les holders doivent alors te faire confiance sur ce point, donc annonce-le clairement.

## Les oracles (`oracle/`)

Deux feeds Switchboard On-Demand sont à créer : `xray-feed.json` (flux X maximal sur 6 h) et `kp-feed.json` (dernier Kp). Ce sont des brouillons : la syntaxe des filtres JSONPath doit être vérifiée dans le simulateur Switchboard avant usage. Le programme refuse toute valeur vieille de plus de 150 slots (environ 1 minute). Quelqu'un doit donc mettre le feed à jour dans la même transaction que `arm`, comme c'est l'usage avec Switchboard On-Demand.

Comme le feed X prend le maximum sur 6 h, deux éruptions M à moins de 6 h d'intervalle ne comptent que pour une.

## Déployer sur devnet

```bash
# 1. Outils : Rust, Solana CLI (Agave) et Anchor 0.32
# 2. Clé du programme, puis mettre l'adresse dans declare_id! (lib.rs) et Anchor.toml
anchor keys sync
anchor build
anchor deploy --provider.cluster devnet
# 3. Créer les deux feeds Switchboard (oracle/*.json), puis appeler initialize
#    avec ton wallet dev, dev_bps = 5000 (50 %) et les adresses des feeds.
```

## Avant le mainnet

1. **Tester sur devnet** de bout en bout : distribute, puis arm, puis execute avec une vraie route Jupiter.
2. **Keeper :** écrire le bot qui appelle `execute` avec un `min_out` tiré du devis Jupiter. Si sa clé fuitait, l'attaquant pourrait encore sandwicher les burns : pour l'éviter complètement, ajouter plus tard un contrôle de prix on-chain (feed $SFIRE/SOL).
3. **Hasard :** la v1 utilise le dernier hash de slot. Celui qui appelle `arm` peut choisir son moment pour viser un montant plus haut ou plus bas dans la fourchette. Pour un hasard vraiment imprévisible, il faut passer à Switchboard Randomness.
4. **Audit** du programme par un tiers.
