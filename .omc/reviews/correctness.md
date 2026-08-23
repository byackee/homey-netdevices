# Revue — rôle `code-reviewer`, angle **défauts de logique et de correction**

Périmètre : conversions d'unités, propagation de `null`, index de table, sentinelles APC,
cohérence OID/annexe A, et la logique de décision qui en découle (`poll-engine.mts`,
`capability-map.mts`, chaîne de pairing).

**Méthode.** Chaque constat porte sa mention : `[EXÉCUTÉ]` quand je l'ai fait tomber en
lançant le code compilé de `.testbuild/`, `[LECTURE]` quand il vient de la lecture seule.
`npm test` : 229/229 au vert avant et après — **aucun** des constats `[EXÉCUTÉ]` ci-dessous
ne fait rougir la suite. Scripts de vérification dans le scratchpad de session, aucun fichier
du dépôt modifié.

**Ce que j'ai vérifié et qui est juste, en une ligne chacun** — je n'y reviens plus :

- `[EXÉCUTÉ]` **43 OID du code comparés un à un à `.omc/plans/annexe-a-oid.md` : zéro écart.**
  RFC 1628 (scalaires, colonnes `.3.3.1.x` / `.4.4.1.x`, table d'alarmes, base
  `…33.1.6.3` des 24 alarmes), APC PowerNet, Synology `6574.4`. Les tables s'indexent
  bien à 1 (`RFC1628_DEFAULT_LINE`, `ALARM_OIDS` en `i + 1`) ; je n'ai trouvé nulle part
  un `.0` posé sur une colonne.
- `[EXÉCUTÉ]` **Les quatre unités d'autonomie convergent.** 1 000 s Synology → 16,7 min ;
  100 000 TimeTicks APC → 16,7 min ; RFC 1628 non convertie. Fixture délibérément
  non piégeuse (§8.5 : une valeur qui vaut 60 ne prouverait rien).
- `[EXÉCUTÉ]` **Les sentinelles APC sont écartées** : `4294967295` → `null`, `255` °C → `null`.
- `[EXÉCUTÉ]` **Les dixièmes sont partiels et corrects** : `batteryVoltage` 273 → 27,3 V,
  tandis que `inputVoltage` 230 et `outputVoltage` 231 traversent en volts entiers.
- `[EXÉCUTÉ]` **`null` se propage** : sur une réponse vide, les trois lecteurs rendent
  `status: 'unknown'`, quatre alarmes à `false` et **aucune** mesure à `0`.
  `secondsToMinutes(0)` vaut bien `0`, `secondsToMinutes(-1)` vaut `null`.

Je n'ai donc **rien trouvé sur le cœur du sujet annoncé** — unités et `null`. Les cinq
constats qui suivent sont ailleurs : dans la logique qui *consomme* ces valeurs, et dans
la couche non testable (driver, device), où ils sont tous les cinq **muets**.

---

## 1. 🔴 Le balayage écrit `community: 'public'` en dur — tout appariement sur une communauté personnalisée naît mort

**Le problème.** `drivers/ups/driver.mts:521`, dans `fromScan()` :

```ts
device: buildCandidate({
  host: found.host,
  source: found.source,
  version: 'v2c',
  community: 'public',   // ← la communauté saisie par l'utilisateur est perdue ici
```

La vue de pairing propose un champ « community » (`drivers/ups/pair/start.html:144`, défaut
`public`), l'envoie sur `scan_start`, et `UpsDriver` la transmet correctement au balayage :
`app.startScan(this.pairedHosts(), community)` (`driver.mts:243`), qui la passe à
`scanSubnet` (`app.mts:234-237`). L'onduleur **est donc bien trouvé** sur la communauté
personnalisée. Mais la ligne du résultat, elle, est reconstruite avec `'public'`, et c'est
cet objet-là que la vue passe verbatim à `Homey.createDevice()`
(`start.html:371`). L'appareil est créé avec `settings.community = 'public'`.

Le chemin voisin est juste, ce qui achève de désigner un oubli plutôt qu'un choix :
`fromProbe()` (`driver.mts:459-495`) reçoit `community` en paramètre et le propage.
L'ajout manuel d'adresse marche donc, et le balayage — le chemin principal — ne marche pas.

**Pourquoi ça compte.** L'utilisateur qui a changé sa communauté SNMP (cas courant dès qu'un
NAS est un peu configuré) voit son onduleur dans la liste, l'adopte, et obtient un appareil
qui ne lit **jamais rien** : trois échecs, « Aucune réponse SNMP. Vérifiez l'adresse, la
communauté… ». Il vient d'entrer la bonne communauté trente secondes plus tôt et il la voit
juste, `public`, dans les réglages. Rien dans les traces ne dit que le balayage, lui, avait
réussi avec l'autre. C'est exactement le profil de panne du §8 : silencieuse, invisible à
`npm test`, invisible à `homey app validate`.

**Aucun test ne peut l'attraper aujourd'hui** : `buildCandidate` est testé *avec* une
communauté personnalisée (`test/drivers/pairing.test.mts:53-54`, `community: 'privé'`), donc
la couche testable est verte ; c'est l'appelant, dans `Homey.Driver`, qui perd la valeur.

**Le correctif.** Porter la communauté dans l'état de balayage plutôt que de la redeviner :

1. `app.mts` — ajouter `community: string` à `ScanState` (`app.mts:70-88`) et le renseigner
   dans `startScan` (`app.mts:223-231`) à côté de `subnet`.
2. `driver.mts:498` — `private fromScan(found: ScanFinding, community: string): Finding`,
   et remplacer la ligne 521 par `community`.
3. `driver.mts:269` et `:284` — passer `state.community` aux deux `.map(...)`.

Corollaire à traiter dans la foulée : `startScan` rend l'état en cours **sans regarder la
communauté demandée** (`app.mts:200`). Un second driver qui lance un pairing avec une autre
communauté hérite en silence des résultats du premier. Une trace `trace.warn` sur ce cas
suffit ; l'ignorer sans le dire est ce qui rend le diagnostic impossible ensuite.

---

## 2. 🔴 `OL DISCHRG` déclenche une fausse coupure de courant — et le fichier documente lui-même que cette combinaison a été observée en production

**Le problème.** `lib/ups/nut-status.mts:100-108` et `:127-134`.

```ts
if (hasFlag(status, 'OB') || hasFlag(status, 'DISCHRG')) return 'battery';  // ligne 103
...
onBattery: hasFlag(status, 'OB') || hasFlag(status, 'DISCHRG'),             // ligne 129
```

`DISCHRG` est testé **avant** `OL`, et sans lui. Or `OL` et `DISCHRG` ne répondent pas à la
même question : `OL`/`OB` disent d'où vient le courant, `CHRG`/`DISCHRG` disent ce que fait
la batterie. Elles se combinent, et l'en-tête du fichier lui-même (`nut-status.mts:10-11`)
l'écrit noir sur blanc : *« En production sur Synology, trois combinaisons ont été observées
— `OL`, `OL CHRG`, `OL DISCHRG` »*.

`[EXÉCUTÉ]` sur `.testbuild/lib/ups/nut-status.mjs` :

| `ups.status` | `toUpsStatus` | `alarms.onBattery` |
|---|---|---|
| `OL` | `normal` | `false` |
| `OL CHRG` | `normal` | `false` |
| **`OL DISCHRG`** | **`battery`** | **`true`** ← secteur présent, coupure annoncée |
| **`OL DISCHRG CAL`** | **`battery`** | **`true`** ← calibration programmée |
| `OB` | `battery` | `true` |

**Pourquoi ça compte.** `alarms.onBattery` est la seule entrée de `wentOnBattery`
(`poll-engine.mts:284`), qui déclenche `ups_went_on_battery` — *le* déclencheur qui justifie
l'app, celui sur lequel l'utilisateur branche l'extinction de ses appareils non essentiels et
de son NAS. Un onduleur qui recharge mal, un test de batterie hebdomadaire, une calibration :
tout cela lève `DISCHRG` en gardant `OL`, et coupe les appareils de l'utilisateur en pleine
nuit alors que le secteur n'a jamais bronché. C'est mot pour mot le scénario que le §8.5
décrit et que le reste du fichier prend tant de soin à éviter.

L'asymétrie avec la branche APC est frappante et la désigne comme un oubli : `apc-reader.mts`
a `APC_TEST_STATUSES` et exclut explicitement les états de test de `onBattery`
(`apc-reader.mts:203-206`, commentaire *« un test de batterie hebdomadaire ne doit pas éteindre
ses appareils non essentiels à trois heures du matin »*). La branche NUT n'a pas d'équivalent :
ni pour `CAL`, ni pour `DISCHRG`-avec-`OL`.

**Ce que les tests épinglent — et ce qu'ils laissent passer.** `test/ups/nut-status.test.mts:68`
fixe `toUpsStatus('DISCHRG') === 'battery'` — défendable, `DISCHRG` **seul** veut bien dire que
la batterie alimente. Mais `test/ups/nut-status.test.mts:14` ne teste de `'OL DISCHRG'` que le
découpage en jetons, jamais son repli. La combinaison qui pose problème est la seule des trois
combinaisons observées en production dont le sens n'est pas testé.

**Le correctif.** `nut-status.mts` — faire primer l'état secteur, qui est l'information
autoritative, et n'accorder à `DISCHRG` que le rôle de repli :

```ts
// toUpsStatus, ligne 103 — OL est autoritatif sur DISCHRG
if (hasFlag(status, 'OB')) return 'battery';
if (hasFlag(status, 'DISCHRG') && !hasFlag(status, 'OL')) return 'battery';

// toUpsAlarms, ligne 129 — et surtout : pas de coupure quand le secteur est là
onBattery: hasFlag(status, 'OB') || (hasFlag(status, 'DISCHRG') && !hasFlag(status, 'OL')),
```

Et, par symétrie avec `APC_TEST_STATUSES`, exclure `CAL` de `onBattery` : une calibration est
un événement programmé, pas une panne. `status` peut rester `'battery'` — la capability doit
dire la vérité sur d'où vient le courant ; c'est l'**alarme** qui ne doit pas partir.

---

## 3. 🔴 Le gel du §3.8 se décide sur `status`, le déclencheur sur `alarms.onBattery` — quand les deux divergent, l'app annonce « le courant est revenu » au moment où elle perd le contact

**Le problème.** `drivers/ups/poll-engine.mts:204` :

```ts
const duringOutage = this.lastKnownStatus === 'battery';
```

`ContactTracker` mémorise `live.status` (`:172`) et juge le gel dessus. Mais tout le reste de
la chaîne — `wentOnBattery`, `mainsRestored`, la condition Flow `ups_is_on_battery`
(`device.mts:372`) — se décide sur `live.alarms.onBattery`. Ce sont **deux notions
différentes de « sur batterie »**, et elles divergent pour de bon :

`[EXÉCUTÉ]` sur `.testbuild/lib/ups/nut-status.mjs` — l'ordre de test de `toUpsStatus` place
`OFF` et `BYPASS` avant `OB` :

| `ups.status` | `status` | `alarms.onBattery` |
|---|---|---|
| `OB BYPASS` | `bypass` | `true` |
| `OFF OB` | `off` | `true` |

Côté RFC 1628 la divergence est encore plus directe : `decodeAlarms`
(`rfc1628-reader.mts:303`) pose `onBattery: outputSource === battery || has('onBattery')`.
Un agent qui rend `upsOutputSource = booster(6)` (correction de tension pendant une chute de
secteur, cas fréquent en début de coupure) avec une ligne `onBattery` dans `upsAlarmTable`
donne `status: 'booster'` et `onBattery: true`.

`[EXÉCUTÉ]` sur `.testbuild/drivers/ups/poll-engine.mjs`, avec
`{ status: 'bypass', alarms.onBattery: true }` puis trois échecs :

```
succès  : ok            wentOnBattery=true
échec 1 : absorbing     live = null
échec 2 : absorbing     live = null
échec 3 : unreachable   live = "unknown"
           déclencheurs => {"mainsRestored":true,"statusChanged":true}
```

**Pourquoi ça compte.** Deux dégâts en une fois, et ce sont les deux que le §3.8 existe pour
empêcher :

1. **Le gel ne s'arme pas.** `LIVE_UNKNOWN` est publié, les mesures repartent à `null`,
   l'état affiché passe de « bypass » à « inconnu » — alors qu'on ne sait rien.
2. **`ups_mains_restored` part.** `LIVE_UNKNOWN.alarms.onBattery` vaut `false`
   (`poll-engine.mts:138`), donc `mainsRestored = wasOnBattery && !live.alarms.onBattery`
   (`:285`) est vrai. L'app **affirme que le courant est revenu** au moment précis où elle
   vient de perdre le contact pendant une coupure. C'est le mensonge que le commentaire de
   `applyOutcome` (`device.mts:249-255`) jure de ne pas commettre — *« Un `setCapabilityValue`
   de plus ici, et l'app annoncerait implicitement que le courant est revenu »* — commis par
   l'autre porte.

Et `ups_contact_lost_during_outage`, lui, ne part pas.

**Le correctif.** `ContactTracker` doit mémoriser la **même** notion que celle qui arme les
déclencheurs. `poll-engine.mts` :

```ts
// champ, en remplacement de lastKnownStatus pour ce qui touche au gel
private lastKnownOnBattery = false;

// succeeded(), vers la ligne 172
this.lastKnownOnBattery = live.alarms.onBattery || live.status === 'battery';

// failed(), ligne 204
const duringOutage = this.lastKnownOnBattery;
```

`lastKnownStatus` peut rester pour `lastStatus`, qui n'est que du diagnostic. Un test à
ajouter : `{ status: 'bypass', alarms.onBattery: true }` puis trois échecs doit rendre
`reason === 'lost-during-outage'`, `live === null`, et **aucun** `mainsRestored`.

---

## 4. 🟠 `ContactTracker.reset()` garde l'affirmation qu'il prétend abandonner : après un changement d'adresse, le nouvel appareil reste gelé sur « batterie »

**Le problème.** `poll-engine.mts:227-230`. La méthode dit *« Remet le compteur à zéro sans
rien affirmer »* et remet effectivement `failures` et `outageAnnounced` à zéro — mais laisse
`lastKnownStatus` et `available` intacts.

`[EXÉCUTÉ]` :

```
après reset, lastStatus = battery
3 échecs sur la NOUVELLE adresse -> reason = lost-during-outage | live = null (gelé sur « batterie »)
```

**Pourquoi ça compte.** `device.mts:418` appelle `this.contact.reset()` sur tout changement
de `host` / `community` / `version`. Le scénario est réaliste : l'onduleur passe sur batterie,
l'utilisateur constate que l'app ne répond plus, corrige l'adresse — et fixe l'appareil sur
un état « batterie » qu'il ne pourra plus jamais quitter tant que la nouvelle adresse est
muette. Aucune écriture n'a lieu (`live === null`), donc la tuile reste éternellement sur
« sur batterie », charge et autonomie figées aux dernières valeurs de l'ancien appareil.
Le commentaire de `onSettings` (`device.mts:411-412`) dit pourtant l'intention exacte :
*« les échecs d'avant et le relevé d'avant portaient sur une conversation qui n'existe plus »*.

**Le correctif.** `poll-engine.mts:227` :

```ts
reset(): void {
  this.failures = 0;
  this.outageAnnounced = false;
  this.lastKnownStatus = null;       // ← ajouté : plus rien n'est affirmé
  this.lastKnownOnBattery = false;   // ← si le correctif n°3 est appliqué
}
```

`available` peut rester tel quel : il décrit ce que Homey affiche, pas ce qu'on affirme de
l'onduleur. Test à ajouter : après `succeeded({status:'battery'})` puis `reset()`, trois
échecs doivent donner `unreachable` et non `lost-during-outage`.

---

## 5. 🟠 `ensureReader()` refait une détection complète à chaque tick tant qu'aucun dialecte ne répond — l'inverse de ce que son commentaire promet

`[LECTURE]` `drivers/ups/device.mts:145-160`. Le commentaire annonce *« Écriture persistante,
donc une seule fois et sur changement : la détection ne revient qu'après un échec de
résolution, jamais à chaque relevé »*. Le code, lui, sort par `return null` sans rien mémoriser
quand `detection.reader === null` : `this.reader` reste `null`, et l'appel suivant rejoue tout.

Conséquence, sur un appareil joignable qui ne parle aucun des trois dialectes (une imprimante
à l'adresse d'un ancien onduleur, un NAS dont l'onduleur a été débranché de DSM) :
`detectUpsSource` enchaîne trois sondes SNMP **toutes les 10 secondes** par le groupe rapide,
plus trois autres toutes les 5 minutes par le groupe lent — soit ~18 requêtes/minute sur un
appareil qui a déjà dit non trois fois. `pollLive` et `pollDetail` ont des gardes de réentrance
**distinctes** (`device.mts:78-79`, à raison), donc rien n'empêche les deux détections de
tourner en parallèle et d'écrire `setStoreValue('source', …)` toutes les deux.

Ce n'est pas une panne, c'est du martèlement — et le commentaire de `LIVE_RHYTHM`
(`poll-engine.mts:30-34`) explique justement que certains firmwares de carte réseau brident
les requêtes. Un onduleur bridé qui refuse au troisième paquet ressemblera à un onduleur
injoignable.

**Le correctif.** Mémoriser le refus avec une temporisation (une détection au plus toutes les
~5 min), et mutualiser la résolution entre les deux groupes : un seul `Promise` de détection
en vol, partagé, plutôt qu'un appel par groupe.

---

## 6. 🟡 Une source inconnue dans le `store` fait planter chaque écriture de capability

`[EXÉCUTÉ]` — `capability-map.mts:191` (`planCapabilities`) et `:228` (`capabilityValues`)
indexent `ALARM_SUPPORT[snapshot.source]` sans garde :

```
source inconnue  ->  TypeError: Cannot read properties of undefined (reading 'overload')
planCapabilities ->  TypeError: Cannot read properties of undefined (reading 'batteryLow')
```

`device.mts:127-130` alimente ce champ depuis le `store` avec un cast non validé :

```ts
const stored = this.getStoreValue('source') as unknown;
return typeof stored === 'string' ? (stored as UpsSource) : null;   // toute chaîne passe
```

Aujourd'hui le `store` n'est écrit que par `buildCandidate` et `ensureReader`, donc les
valeurs sont contraintes et le chemin n'est pas atteint. Il le devient au premier ajout de
dialecte (`'qnap'` est déjà dans le type `UpsSource` sans lecteur, `'cyberpower'` est annoncé
dans les commentaires) : un appareil appairé par une version qui connaît le dialecte, ouvert
par une version qui ne le connaît plus, lève à chaque `writeValues()` — et l'exception
remonte hors de `applyOutcome`, donc hors du `void this.pollLive()` de `device.mts:108` et
`:419`, en rejet non traité.

**Le correctif.** Valider à la lecture, ce qui est déjà possible sans rien ajouter :

```ts
// device.mts:127
private storedSource(): UpsSource | null {
  const stored = this.getStoreValue('source') as unknown;
  return typeof stored === 'string' && readerForSource(stored as UpsSource) !== null
    ? (stored as UpsSource) : null;
}
```

et, en ceinture, un repli explicite dans `capability-map.mts` (`ALARM_SUPPORT[source] ??
ALARM_SUPPORT.qnap`, la ligne la plus conservatrice) plutôt qu'un `undefined` qui lève.

---

## 7. 🟡 `foreign` et `truncated` sont calculés puis jetés

`[LECTURE]` `rfc1628-reader.mts:146-162` produit un `Rfc1628AlarmScan` complet, et
`decodeAlarms` (`:300-312`) n'en lit que `present`. `grep` sur tout le dépôt hors tests :
`foreign` et `truncated` n'apparaissent **nulle part** ailleurs. Aucun `trace.*`, aucun `log`.

Deux informations utiles disparaissent donc en silence : l'onduleur qui remonte des alarmes
sous sa MIB privée (piège n°5 de l'annexe — l'app dégrade proprement, c'est bien, mais
personne ne saura jamais pourquoi une alarme n'apparaît pas), et le dépassement de la fenêtre
de `RFC1628_ALARM_PROBE_COUNT = 6`, dont le commentaire (`:47-56`) reconnaît pourtant que
c'est un compromis assumé. Un compromis qu'on ne peut pas constater n'est pas un compromis,
c'est un angle mort.

Détail au passage : `seen = present.length + foreign.length` compte **après** dédoublonnage
(`:160`), donc six lignes portant la même alarme donnent `seen = 1` et `truncated = true` à
tort.

**Le correctif.** Une trace, une seule, dans `readLive` :
`if (scan.truncated || scan.foreign.length > 0) trace.info('ups', 'alarmes partielles', scan);`
et compter `descriptors.filter((d) => d !== null).length` pour `seen`.

---

## 8. 🟡 Trois broutilles, groupées

- **`secondsToMinutes` recopie `roundTenth`.** `reader.mts:136-139` écrit
  `Math.round((seconds / 60) * 10) / 10` alors que `units.mts` exporte `roundTenth` et que
  son en-tête déclare que les conversions vivent là « plutôt que recopiées dans chaque
  lecteur ». Le calcul est juste `[EXÉCUTÉ]`, mais la duplication est exactement ce que le
  fichier dit vouloir éviter. Déplacer `secondsToMinutes` dans `units.mts`, à côté de
  `timeTicksToMinutes` — les quatre unités seraient alors dans un seul fichier, ce qui est
  l'intention affichée.
- **Le total du balayage peut être sous-estimé.** `app.mts:219` compte comme « ignorées »
  toutes les adresses de `skip` préfixées par le sous-réseau, y compris `x.y.z.0` et
  `x.y.z.255` que `scanSubnet` n'énumère pas (`scan.mts:100`, `1..254`). `total` tombe alors
  sous le nombre réel de cibles et `probed` le dépasse ; c'est masqué par le
  `Math.min(state.probed, state.total)` de `driver.mts:279` et `api.mts:83`, mais la barre
  saturera avant la fin. Filtrer sur le dernier octet en `1..254`.
- **Rejets non traités.** `device.mts:108-109`, `:174`, `:180` et `:419-420` lancent
  `void this.pollLive()` sans `.catch()`. `pollLive` avale les erreurs de lecture, mais pas
  celles d'`applyOutcome` (cf. constat 6). Ajouter un `.catch((e) => this.error(…))` — Node
  ≥ 15 fait tomber le processus sur un rejet non traité, et une app Homey qui redémarre en
  boucle ne laisse aucune trace exploitable.
