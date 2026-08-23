# Revue — adéquation des tests

**Rôle : test-engineer.** Angle : que prouvent réellement les 229 tests, et quelles mutations survivent.

Méthode : copie isolée du dépôt (`rsync` + symlink `node_modules`, aucune écriture dans le dépôt
partagé), `npm test` en base (229/229 verts, confirmé), puis mutations réelles du code compilé/source
dans cette copie, une à la fois, avec restauration entre chaque. Neuf mutations exécutées ; leur verdict
est marqué **vérifié en exécutant**. Le reste (lecture des fichiers de test) est marqué **déduit**.

---

## 1. `drivers/ups/device.mts` — zéro test, et une mutation qui désactive `setUnavailable` passe intégralement

**Vérifié en exécutant.** Aucun fichier `test/drivers/device.test.mts` n'existe, et rien dans
`test/**` n'importe `device.mts` (`grep` sur `device.mjs`/`device.mts` dans `test/` : aucun résultat).
Mutation : remplacer la garde de sortie précoce dans `handlePollOutcome`
(`if (outcome.reason === 'absorbing' || !this.getAvailable()) return;`) par `if (true) return;` —
ce qui désactive **tout appel à `setUnavailable`**, quel que soit le nombre d'échecs consécutifs ou
l'état de coupure. Résultat : `npm test` → 229/229 verts, 0 échec.

Pourquoi ça compte : c'est la classe de panne exacte que le plan §8 décrit — invisible à `npm test`,
invisible à `homey app validate`, et qui ne se découvre que sur du vrai matériel. `poll-engine.mts` est
bien testé (voir §3) : la *décision* (« cet onduleur doit passer indisponible », « le contact perdu
pendant une coupure doit figer l'état ») est correctement calculée et pinnée par
`test/drivers/poll-engine.test.mts`. Mais rien ne vérifie que `device.mts` **applique** cette décision —
ni `setAvailable`/`setUnavailable`, ni `writeValues()` (la boucle `setCapabilityValue` de
`device.mts:309`), ni `onSettings` (reconfiguration adresse/community), ni le respect du commentaire
« Aucun SET, sans exception » (`device.mts:11`). Un régression totale du branchement — l'appareil ne
serait plus jamais marqué indisponible pendant une vraie coupure — ne ferait tomber aucun test.

Correctif : un test qui instancie une classe de test minimale (double léger de `Homey.Device` —
`setAvailable`/`setUnavailable`/`setCapabilityValue`/`error` en espions, pas le SDK réel), branche
`poll-engine.mts` dessus comme `device.mts` le fait, et vérifie qu'un outcome `unreachable` finit bien
en `setUnavailable` appelé, qu'un `lost-during-outage` fige l'état sans y toucher, et qu'`ok` écrit les
bonnes capabilities. Le fichier lui-même dit pourquoi ce découpage existe (`poll-engine.mts:1-11`) — il
manque la moitié du filet : le test du module pur, sans celui de l'adaptateur qui le consomme.

---

## 2. Le piège §8.5 (fixtures d'unité indiscernables) — bien paré, vérifié par mutation réelle

**Vérifié en exécutant**, six mutations, toutes tuées :

| Mutation | Fichier | Fixture qui la tue |
|---|---|---|
| `timeTicksToMinutes` : `÷6000` → `÷60` | `lib/ups/units.mts:55` | `test/ups/units.test.mts:29` (150 000 → 25, pas 2500) |
| `secondsToMinutes` (Synology) : `÷60` → `÷6000` | `lib/ups/reader.mts:138` | `test/ups/synology-source.test.mts` (1500 s → 25 min) |
| `apcRuntimeMinutes` : sentinelle `4294967295` retirée | `lib/ups/apc-reader.mts:127` | `test/ups/apc-reader.test.mts:63` |
| `asMeasure` (Synology) : clamp au lieu de `null` hors bornes | `lib/ups/reader.mts:158` | `test/ups/reader.test.mts:145` |
| `RFC1628_DEFAULT_LINE` : `1` → `0` | `lib/ups/rfc1628-mib.mts:123` | `test/ups/sources.test.mts:79` |
| `toNumber` : `null` → `0` sur OID absent | `lib/snmp/opaque.mts:46` | `test/ups/synology-source.test.mts:86` |
| Priorité `toUpsStatus` : `OL` testé en premier | `lib/ups/nut-status.mts` | `test/ups/nut-status.test.mts:48` (`"OL BOOST"` doit rendre `booster`) |
| Capability déclarée même quand `value === null` | `lib/ups/capability-map.mts:183` | `test/ups/capability-map.test.mts:272` |

C'est précisément le garde-fou que `test/ups/units.test.mts:5-11` documente en tête de fichier
(« avec une valeur mal choisie, diviser par dix et ne rien faire donnent le même résultat ») — et les
fixtures d'autonomie sont bien choisies : Synology `1500 s`, APC `150 000` centièmes, RFC `25` min,
toutes convergeant vers `25` min mais par des chemins que `assert.notEqual` distingue explicitement à
chaque niveau (`units.test.mts`, `reader.test.mts`, `apc-reader.test.mts`, `rfc1628-reader.test.mts`).
Rien à ajouter sur ce point précis — c'est la partie la mieux défendue du projet.

Note pour l'angle correctness : `intervalMs(1, LIVE_RHYTHM)` (`poll-engine.test.mts:59`) vérifie que le
plancher de 5 s s'engage réellement sur une valeur qui le dépasse — exactement l'équivalent du piège
`minDwellSec` de vtherm (§8.5), correctement évité ici.

---

## 3. `apcTemperature` : la sentinelle `255` est protégée par le bornage, pas testée isolément

**Vérifié en exécutant.** Mutation : retirer `n === APC_TEMPERATURE_UNSUPPORTED` de
`apcTemperature` (`lib/ups/apc-reader.mts:115`), ne garder que `n === null`. Résultat :
229/229 verts, **la mutation survit**.

Cause : `APC_TEMPERATURE_UNSUPPORTED = 255` (`apc-mib.mts:68`) est déjà au-dessus de
`APC_TEMPERATURE_PLAUSIBLE_MAX = 150` (`apc-reader.mts:100`) — le bornage de plausibilité écarte donc
`255` à lui seul, et `test/ups/apc-reader.test.mts:75` (`apcTemperature(APC_TEMPERATURE_UNSUPPORTED)
=== null`) ne distingue pas « rejeté par la sentinelle » de « rejeté par le bornage ». C'est **documenté
et assumé** dans le commentaire du code (`apc-reader.mts:96-99`) et un test-relation existe
(`apc-reader.test.mts:88`, `APC_TEMPERATURE_UNSUPPORTED > APC_TEMPERATURE_PLAUSIBLE_MAX`) pour alerter
si un jour le bornage s'élargit au-delà de 255. C'est une fragilité mineure, connue, avec un filet
partiel — pas une faille silencieuse — mais la ligne de sentinelle elle-même n'est pinnée par aucun
test qui l'isole du bornage. Un test qui appelle `apcTemperature` avec une valeur `> 150` mais
`≠ 255` ne changerait rien à la conclusion ; il faudrait un test qui déplace temporairement le seuil ou
compare les deux chemins de rejet pour vraiment isoler la ligne. Gravité mineure : correctif optionnel.

---

## 4. Ce qui est solide et n'appelle pas de commentaire supplémentaire

`test/views/pair-view.test.mts` charge et exécute réellement le JS des vues `start.html`/`repair.html`
dans un DOM minimal (`test/views/dom.mjs`), pas seulement leur présence sur disque — c'est la parade
vtherm du plan §8.4, et le fichier documente lui-même pourquoi (`pair-view.test.mts:1-13`). Vérifié à la
lecture (`readFileSync` sur les vrais fichiers, `parseView`/`stripComments` puis exécution), pas rejoué
en mutation faute de temps, mais l'architecture du test rend crédible qu'il attrape les pannes 2, 3, 7,
8 du rétro qu'il cible explicitement par numéro.

`test/ups/sources.test.mts` teste l'ordre d'essai (Synology → RFC 1628 → APC), le cas « deux dialectes
répondent, le premier de la liste gagne », et qu'une source en échec n'empêche pas les suivantes de
répondre — les trois scénarios qui comptent pour un mécanisme de repli.

---

## Résumé, par gravité

1. **`device.mts` (446 lignes) sans aucun test** — la logique de décision est testée
   (`poll-engine.mts`), son branchement en effets Homey réels ne l'est pas du tout ; une désactivation
   totale de `setUnavailable` passe la suite sans le moindre échec. *(vérifié)*
2. **`apcTemperature` : sentinelle non isolée du bornage** — mineur, déjà documenté et partiellement
   gardé par un test de relation entre constantes. *(vérifié)*
3. Le piège central du plan (§8.5, conversions d'unité à quatre dialectes) est correctement paré par
   des fixtures discernables — six mutations directes, toutes tuées. *(vérifié)*
