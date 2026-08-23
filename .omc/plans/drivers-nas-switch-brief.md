# Brief — drivers NAS et switch/PoE

App **« SNMP - Network Devices »** (`com.dataweavelabs.netdevices`), TypeScript ESM, SDK Homey v3.
243 tests passent, `homey app validate --level publish` passe, l'app tourne sur un vrai Homey.
**Ne rien casser de ça.**

Le driver `ups` existe et sert de modèle : lis-le avant de commencer. **Ne le modifie pas.**

**OID exacts** : `.omc/plans/annexe-a-oid.md` §3 (POWER-ETHERNET, RFC 3621) et §4 (IF-MIB, RFC 2863).
**Garde-fous** : `.omc/plans/autopilot-impl.md` §8 — les neuf pannes de pairing, toutes muettes.
**Ce que la revue a trouvé** : `.omc/reviews/` — quatre pannes, toutes **aux jointures entre lanes**.

---

## Le socle est déjà là, ne le réécris pas

| Module | Ce qu'il donne |
|---|---|
| `lib/snmp/client.mts` | sessions SNMP, v1/v2c |
| `lib/snmp/scan.mts` | balayage à sonde paramétrée |
| `lib/snmp/opaque.mts` | `toNumber()` — **à utiliser partout**, il préserve `null` |
| `lib/snmp/trace.mts` | tampon de traces |
| `lib/device/rhythm.mts` | `LIVE_RHYTHM`, `DETAIL_RHYTHM`, `PollGate`, `intervalMs`, `FAILURES_BEFORE_VERDICT` |
| `lib/ups/capability-sync.mts` | `syncCapabilities(plan, sink)` — **générique**, prend un plan |
| `lib/ups/capability-map.mts` | `reconcileCapabilities()` — ajoute, ne retire **jamais** |

---

## Non-collision

| Lane | Écrit **uniquement** dans |
|---|---|
| **J** | `lib/nas/**`, `drivers/nas/**`, `test/nas/**` |
| **K** | `lib/netswitch/**`, `drivers/netswitch/**`, `test/netswitch/**` |

Jamais `git stash`, `git reset`, `git checkout`, `git add -A`. Commit par pathspec explicite.
Ne touche pas à `lib/snmp/`, `lib/device/`, `lib/ups/`, `drivers/ups/`, `package.json`, `tsconfig*`.
Vérifie `npm run typecheck`, `npm test` **et** `npx homey app validate --level publish`.

---

## Lane J — driver NAS / hôte

`HOST-RESOURCES-MIB` (RFC 2790), base `1.3.6.1.2.1.25`. MIB **standard** : un driver, toutes les
marques — Synology, QNAP, un Linux avec `snmpd`, un ESXi.

Capabilities : charge CPU (%), mémoire utilisée (%), stockage utilisé (%) par volume, uptime.
`measure_temperature` si l'hôte l'expose. Capabilities custom dans `.homeycompose/capabilities/`.

- `hrProcessorLoad` (`.25.3.3.1.2`) est une **table** : une ligne par cœur ⇒ moyenner, et le dire.
- `hrStorageTable` (`.25.2.3.1`) mélange RAM, swap, systèmes de fichiers et disques virtuels :
  filtrer sur `hrStorageType`. Un `/dev/shm` affiché comme « disque » est un défaut.
- `hrStorageSize` × `hrStorageAllocationUnits` peut **déborder un entier 32 bits** sur un gros
  volume : calculer en octets avec des `number` flottants, jamais en entiers 32 bits.
- `hrSystemUptime` est en centièmes de seconde.
- 🔴 `class: 'sensor'`. **Aucune écriture.**

## Lane K — driver switch / PoE

`IF-MIB` (RFC 2863) + `POWER-ETHERNET-MIB` (RFC 3621). Standard également.

**Un port = un device.** Un switch 48 ports ne fait pas un device à 48 capabilities : Homey n'a
aucune représentation utile de ça, et surtout **les Flow cards de `onoff` sont générées par device,
pas par sous-capability**. Le pairing **liste les ports et l'utilisateur coche ceux qui l'intéressent**
— même principe que le choix des sources côté onduleur. Un pairing peut renvoyer plusieurs devices
du moment qu'ils appartiennent au même driver, chacun avec son propre `data.id`, l'hôte partagé
dans `settings`.

Capabilities par port : état du lien (`ifOperStatus`), débit négocié, erreurs, conso PoE (W),
et `onoff` **si et seulement si l'écriture est activée** (voir ci-dessous).

- 🔴 **`ifSpeed` plafonne à 4 294 967 295 bit/s** : au-delà, lire `ifHighSpeed`, en **Mbit/s**.
- 🔴 `ifHCInOctets` / `ifHCOutOctets` sont **Counter64 ⇒ SNMPv2c obligatoire**. En v1 ils sont
  absents : ne pas déclarer la capability plutôt que d'afficher zéro.
- `ifInErrors` / `ifOutErrors` sont des **Counter32 qui débordent** : exposer la valeur brute,
  ne pas calculer de delta sans vérifier `ifCounterDiscontinuityTime`.
- ⚠️ **`pethMainPseTable` est sous `pethObjects.3.1`** (`1.3.6.1.2.1.105.1.3.1`), **pas** sous
  `powerEthernetMIB.3`. L'annexe signale que beaucoup de résumés se trompent là-dessus.
- L'index PoE est `{groupe, port}`, pas un simple numéro de port : le relier à `ifIndex` demande
  une correspondance, qui n'est pas toujours l'identité. Si elle échoue, ne pas inventer.

### 🔴 L'écriture, et son garde-fou

Décision prise : l'écriture est permise **mais désactivée par défaut**.

- Un réglage de device `allow_control`, `type: checkbox`, **`value: false`**.
- Tant qu'il est faux : `onoff` n'est **pas déclarée**, aucun SET n'est émis, et la carte de Flow
  correspondante refuse avec un message qui dit quoi activer.
- Quand il est vrai : `ifAdminStatus` (`1.3.6.1.2.1.2.2.1.7.n`) et `pethPsePortAdminEnable`
  (`1.3.6.1.2.1.105.1.1.1.3.g.p`) deviennent pilotables.
- Le texte du réglage doit avertir franchement : **couper le port qui alimente le Homey, ou le
  routeur, coupe la supervision elle-même** — et il faudra un accès physique pour revenir.

---

## Les pièges qui ont déjà coûté cher ici

- 🔴 **`null` reste `null` jusqu'à la capability.** Une mesure absente ne devient jamais `0`.
  Utiliser `toNumber()` de `lib/snmp/opaque.mjs`, qui applique déjà cette règle.
- 🔴 **Une capability sans valeur n'est pas déclarée.** `removeCapability` détruit l'historique
  Insights de façon irréversible.
- 🔴 **Brancher `syncCapabilities` pour de vrai.** Le bug le plus grave de la revue : le mapping
  existait, testé, et n'était appelé de nulle part — douze mesures sur treize étaient jetées.
  Regarde `drivers/ups/device.mts` pour le branchement correct.
- 🔴 **Aucune écriture persistante dans la boucle de poll.** `syncCapabilities` est idempotent ;
  garde cette propriété.
- 🔴 **Fixtures discernables.** Si toutes les valeurs de test convergent, une conversion ratée
  passe inaperçue. Voir le garde-fou de `test/ups/units.test.mts`.
- 🔴 **Le pairing est là où les trois apps précédentes se sont cassé les dents.** Copie la vue de
  `drivers/ups/pair/`, qui a payé les neuf pannes : pas de `<script src="/homey.js">`, pas
  d'`onHomeyReady`, `Homey.ready()` en premier, une seule vue custom qui crée l'appareil,
  identifiants **préfixés par vue**, et `Homey.emit()` en requête/réponse jamais en push.
