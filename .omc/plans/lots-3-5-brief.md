# Brief d'exécution — lots 3 à 5

App **« SNMP - Network Devices »** (`com.dataweavelabs.netdevices`). TypeScript ESM, SDK Homey v3.

**Plan** : `.omc/plans/autopilot-impl.md` — §3.2 le mapping, §3.4 les rythmes, §8 les garde-fous.
**OID** : `.omc/plans/annexe-a-oid.md` — §1 RFC 1628, §2 APC. Les valeurs y sont vérifiées.
**Contrat commun** : `lib/ups/snapshot.mts` — **déjà écrit, à ne pas modifier**. C'est lui qui
découple les trois lanes : la D le produit, la E le consomme, la F l'orchestre.

Acquis des lots 0–2 : `lib/snmp/` (transport, balayage, traces, Opaque Float) et `lib/ups/`
(OID Synology, jetons NUT, lecteur). 53 tests passent, `homey app validate --level debug` passe.

---

## Règle absolue de non-collision

| Lane | Lot | Écrit **uniquement** dans |
|---|---|---|
| **D** | 3 — lecteurs RFC 1628 + APC | `lib/ups/**` **sauf** `snapshot.mts` et `capability-map.mts`, et `test/ups/**` |
| **E** | 4 — mapping capabilities | `lib/ups/capability-map.mts`, `.homeycompose/capabilities/**`, `test/ups/capability-map.test.mts` |
| **F** | 5 — le device | `drivers/**`, `test/drivers/**` |

- Jamais `git stash`, `git reset`, `git checkout`, `git add -A`. Commit **par pathspec explicite**.
- Ne pas toucher `package.json`, `tsconfig*`, `lib/snmp/**`, `lib/ups/snapshot.mts`.
- `/Users/byackee/Documents/GitHub/homey-netprinter` est en **LECTURE SEULE** : app publiée. On y
  copie des motifs, on n'y modifie rien.
- Vérifier `npm run typecheck` **et** `npm test` avant de committer.

---

## Lane D — lot 3 : les sources RFC 1628 et APC

Aujourd'hui seul un Synology est lisible. Ces deux lecteurs ouvrent l'app à toute carte réseau
d'onduleur, tous constructeurs.

1. `lib/ups/rfc1628-mib.mts` — OID sous `1.3.6.1.2.1.33` (annexe §1).
2. `lib/ups/rfc1628-reader.mts` — implémente `UpsSourceReader`.
3. `lib/ups/apc-mib.mts` + `lib/ups/apc-reader.mts` — `1.3.6.1.4.1.318.1.1.1` (annexe §2).
4. **Conformer le lecteur Synology existant** (`lib/ups/reader.mts`) à `UpsSourceReader`.
5. `lib/ups/sources.mts` — la liste ordonnée : Synology, RFC 1628, APC. Premier qui répond gagne.

🔴 Les quatre pièges, tous documentés en annexe, tous invisibles s'ils sont ratés :
- **Unités en dixièmes** : `upsBatteryVoltage` (0,1 V), `upsInputFrequency` et
  `upsOutputFrequency` (0,1 Hz), les courants (0,1 A). **Mais** `upsInputVoltage` et
  `upsOutputVoltage` sont en **volts entiers**. Se tromper donne un facteur 10 crédible.
- **Index de table = 1, jamais 0** : `...1.5.1`, même sur un onduleur monophasé.
- **APC signale l'absence par une sentinelle** : `255` (température) et `4294967295`
  (TimeTicks) veulent dire « non supporté ». Sans traitement, on affiche
  « 4294967295 minutes restantes ». ⇒ `null`.
- **APC donne l'autonomie en TimeTicks** (centièmes de seconde) : `÷6000` pour des minutes.
  La RFC la donne déjà en minutes : aucune conversion.

`upsOutputSource` (7 valeurs) et `upsBasicOutputStatus` d'APC (**28 valeurs**) se replient tous
deux sur le `UpsStatus` commun. Les alarmes viennent de `upsAlarmTable` en RFC ; un OID d'alarme
inconnu (les constructeurs définissent les leurs) ne doit pas faire échouer la lecture.

**Tests** : une fixture **par source**, avec des valeurs qui rendent les conversions
**discernables**. La lane C a laissé un garde-fou exemplaire dans `test/ups/reader.test.mts`
— reprends-le : si toutes les autonomies valent 60, `÷60`, `÷6000` et « rien » sont indiscernables
et la suite passe au vert sans rien prouver.

---

## Lane E — lot 4 : du snapshot aux capabilities

`lib/ups/capability-map.mts` : `UpsSnapshot` → plan de capabilities. **Aucun import Homey**, pour
rester testable sans Homey qui tourne — c'est le motif de `capability-map.mts` de netprinter, à
lire avant de commencer.

Capabilities standard : `measure_battery` (%), `alarm_battery`, `measure_voltage.input` et
`.output`, `measure_power` (W), `measure_temperature`.
Custom, à créer dans `.homeycompose/capabilities/` : `ups_status` (enum), `ups_load` (%),
`ups_runtime` (min), `alarm_ups_onbattery`, `alarm_ups_overload`, `alarm_ups_replace_battery`.

Trois points qui décident de la qualité :
- 🔴 **Une capability sans valeur n'est pas déclarée** — jamais posée à `null` puis retirée.
  `removeCapability` **détruit l'historique Insights de façon irréversible**. On ne déclare que ce
  qu'on sait lire, dès le pairing.
- `measure_battery` **et** `alarm_battery` imposent `energy.batteries`. Ici c'est légitime, la
  batterie est dans l'appareil : valeur **`["INTERNAL"]`**.
- Les **sous-capabilities** (`measure_voltage.input`) n'obtiennent **aucune Flow card générée**.
  Les titres se posent par `capabilitiesOptions`.

---

## Lane F — lot 5 : le device, enfin un appareil Homey

L'app n'a **aucun driver** aujourd'hui. C'est ce lot qui la rend utilisable.

`drivers/ups/driver.compose.json` : `class: "sensor"`, `platforms: ["local"]`,
`connectivity: ["lan"]`. **Le pairing est le lot 6, pas celui-ci** — se limiter au minimum qui
valide.

`drivers/ups/device.mts` : reprendre la mécanique de
`homey-netprinter/drivers/printer/device.mts`, qui est éprouvée — garde de réentrance,
replanification par `homey.setTimeout`, seuil de 3 échecs avant `setUnavailable`, déclenchement
sur changement, isolation par capability. **Deux différences** :

1. 🔴 **Deux rythmes** au lieu d'un. netprinter poll à 300 s ; ici il faut ~**10 s** pour
   `readLive()` (un passage sur batterie se voit en secondes) et ~**5 min** pour `readDetail()`.
   Un timer par groupe, chacun gardé contre la réentrance, chacun réglable.
2. 🔴 **La perte de contact pendant une coupure n'est pas une panne** (plan §3.8). Le NAS qui
   relaie l'onduleur est lui-même alimenté par l'onduleur : il s'éteint pendant la coupure. Donc :
   - injoignable depuis un état normal ⇒ comportement netprinter, indisponible après 3 échecs ;
   - injoignable alors que le dernier état connu était `battery` ⇒ l'état **reste figé** sur
     `battery`, et un déclencheur distinct part. On ne prétend pas savoir que le courant est revenu.

**Aucune écriture persistante dans la boucle de poll** : à 10 s, un titre réécrit à chaque tick
serait trente fois pire que le défaut corrigé dans netprinter. Écrire sur changement.

**Aucun SET**, sans exception : `upsControl` de la RFC 1628 peut couper l'alimentation de tout ce
qui est branché sur l'onduleur, Homey compris. La v1 est en lecture seule (plan §3.6).

---

## Fini quand

`npm run typecheck`, `npm test` et `npx homey app validate --level debug` passent, et chaque lane a
commité ses seuls fichiers avec un message qui dit **pourquoi**, pas seulement quoi.
