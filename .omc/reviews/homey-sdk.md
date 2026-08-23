# Revue — rôle **architect**, angle **conformité SDK Homey et rétro des neuf pannes** (§8 du plan)

Base : `main`, 229 tests verts (`npm test`, vérifié), `.testbuild` reconstruit pour les mesures.
Tout ce qui suit est classé par gravité décroissante. Chaque constat dit s'il est **vérifié en
exécutant** ou **déduit à la lecture**.

---

## 1. 🔴 Aucune capability n'est jamais ajoutée : chaque onduleur appairé n'en porte qu'**une**

**Vérifié en exécutant.**

`drivers/ups/driver.compose.json:6-8` ne déclare que `["ups_status"]`. `buildCandidate()`
(`drivers/ups/pairing.mts:99-104`) ne pose ni `capabilities`, ni `capabilitiesOptions`. Et
`planCapabilities()` / `reconcileCapabilities()` — les deux fonctions écrites pour cela — ne sont
appelées **de nulle part** en production :

```
$ grep -rn 'planCapabilities\|reconcile\|addCapability' --include='*.mts' . | grep -v test/
lib/ups/capability-map.mts:166:export function planCapabilities(...)
lib/ups/capability-map.mts:267:export function reconcileCapabilities(...)
```

Toutes les autres occurrences sont dans `test/ups/capability-map.test.mts`. Mesuré sur un snapshot
Synology complet :

```
planCapabilities -> 13 capabilities: ups_status, measure_battery, ups_runtime, ups_load,
  measure_voltage.input, measure_voltage.output, measure_voltage.battery, measure_power,
  measure_temperature, alarm_battery, alarm_ups_onbattery, alarm_ups_overload,
  alarm_ups_replace_battery
energy -> {"batteries":["INTERNAL"]}
ce que le device écrit réellement (getCapabilities() = ['ups_status'])
  -> [{"id":"ups_status","value":"battery"}]
```

**Pourquoi ça compte.** `writeValues()` (`drivers/ups/device.mts:307-312`) itère sur
`this.getCapabilities()`. Les lecteurs relèvent la charge, l'autonomie, la charge de sortie, les
tensions, la température et les quatre alarmes toutes les dix secondes, `capabilityValues()` les
calcule correctement — et **douze des treize sont jetées avant d'atteindre Homey**. La tuile
n'affiche qu'une chaîne d'état, Insights n'a aucun historique de batterie ni d'autonomie, l'icône
de batterie de Homey n'existe pas, et `alarm_battery` / `alarm_ups_onbattery` — les deux capabilities
sur lesquelles reposent les notifications de coupure — ne sont jamais portées par l'appareil.

C'est le §3.2 du plan (« on ne déclare que ce qu'on sait lire, **dès le pairing** ») purement et
simplement non implémenté. Ni `npm test` ni `homey app validate` ne peuvent le voir : la carte de
capabilities est testée à fond en isolation, et personne ne teste qu'on l'appelle. C'est très
exactement la forme de la panne 6 du rétro — une liste correcte que rien ne consomme.

Les Flow cards, elles, continuent de partir : `fireTriggers()` lit `this.current`, pas les
capabilities. Le défaut est donc **invisible dans les traces** et ne casse aucun Flow — seulement
tout ce que l'utilisateur voit.

**Correctif.**
1. Au pairing, dans `driver.mts:fromProbe()` / `fromScan()` : faire un cycle complet
   (`readUpsSnapshot()`, déjà écrit, `lib/ups/sources.mts:90`) et passer
   `capabilities: plan.capabilities` et `capabilitiesOptions: plan.options` à `buildCandidate()`,
   qui doit les accepter dans `PairingDevice` (`pairing.mts:46-51`) — ce sont deux des sept clés
   admises, le compilateur les laissera passer.
   ⚠️ `plan.energy` (`{batteries:['INTERNAL']}`) n'est **pas** une clé de résultat de pairing :
   il faut l'appliquer par `this.setEnergy(plan.energy)` dans `onAdded()`/`onInit()`, sinon Homey
   refuse `measure_battery`.
2. Dans `device.mts:onInit()` (ligne 100), après le premier cycle lent : appeler
   `reconcileCapabilities(this.getCapabilities(), planCapabilities(this.current).capabilities)` et
   `addCapability()` pour chaque entrée de `toAdd`. **Sur changement uniquement** — `toAdd` est vide
   au régime établi, donc aucune écriture par tick, §8.6 respecté. C'est aussi le seul chemin de
   rattrapage pour les appareils déjà appairés.
3. Un test qui interdit la régression : `planCapabilities(fullSnapshot()).capabilities` doit être
   inclus dans ce que le pairing produit. Aujourd'hui rien ne relie les deux fichiers.

---

## 2. 🔴 La coupure à 10 s est dépassée sur le chemin **v1** — mesuré à 12,4 s

**Vérifié en exécutant.**

`lib/snmp/client.mts:134-136` : en v1, `get()` retombe sur `getOneByOne()`, **un paquet par OID,
séquentiellement** (ligne 164-195). Le commentaire d'`api.mts:130-136` (« au plus trois sondes de
dialecte et une lecture d'identité, chacune sur un timeout court ») compte des *appels*, pas des
*paquets* : en v1 chaque appel se démultiplie par son nombre d'OID.

Mesuré contre un socket UDP qui reçoit tout et ne répond jamais (`127.0.0.1:11610`) :

```
v2c probe (2 OID, 1200 ms, 0 retry)          ->  1 204 ms
v1  probe (2 OID, 1200 ms, 0 retry)          ->  2 407 ms
v1  readLive APC (7 OID, 2500 ms, 1 retry)   -> 35 029 ms
```

Et le chemin complet de `app.probeAddress()` (`app.mts:345`) rejoué pièce par pièce en v1 :

```
negotiateVersion (2 versions)           cumul  4 005 ms
get sysDescr + sysName                  cumul  6 408 ms
detectUpsSource (3 dialectes)           cumul 12 422 ms
```

**12,4 s, et sans `readIdentity()`.** Même sur un agent qui négocie tout de suite en v1 (la
négociation ne coûte alors que le timeout v2c, 2,0 s), le total atteint 2,0 + 2,4 + 6,0 = **10,4 s**.

**Pourquoi ça compte.** `POST /probe` (`api.mts:137`) est un endpoint d'API : au-delà de dix
secondes Homey coupe, et la page de réglages reçoit une erreur de transport là où le code allait
répondre `reachable` — le verdict que tout le §3.1 bis existe pour produire. Le handler `probe` du
pairing (`driver.mts:289`) partage exactement ce code. C'est la panne §8.2, re-cassée par un chemin
que son garde-fou ne couvrait pas.

Côté device, l'effet est pire mais moins visible : un relevé « rapide » APC en v1 sur un agent muet
prend **35 s** pour un rythme de 10 s. `PollGate` empêche l'empilement, mais le rythme réel devient
35 s et le verdict d'indisponibilité arrive trois fois trop tard.

**Correctif.**
- Borner le budget, pas la requête : passer à `getOneByOne()` une échéance globale
  (`Date.now() + budget`) et sortir de la boucle `for` (ligne 169) dès qu'elle est franchie, en
  rendant `null` pour les OID restants. C'est déjà la sémantique du reste du fichier : un OID sans
  réponse est un `null`, pas un échec.
- Diviser les timeouts par le nombre d'OID quand `version === 'v1'`, à l'appel : dans `app.mts`,
  `PROBE_READ_MS / oids.length`. Moins propre, mais tient en une ligne.
- Et corriger le commentaire d'`api.mts:130-136`, qui affirme aujourd'hui une garantie fausse.

---

## 3. 🟠 La chaîne de timers survit à `onDeleted()` et se dédouble sur `onSettings()`

**Vérifié en exécutant** (modèle réduit fidèle à `device.mts:172-189`, seuls les intervalles sont
raccourcis) :

```
A/ onDeleted pendant un relevé  : 2 relevé(s) APRÈS la suppression (attendu 0)
B/ intervalle changé en vol     : 7 relevés en ~1 s, une seule chaîne en donnerait ~5
```

`scheduleLive()` (ligne 172) réarme depuis le `.finally()` du relevé. `clearTimers()` (ligne 184)
n'annule que le *handle* en attente : si un relevé est **en vol**, son `.finally()` replanifie
après coup, et plus rien ne détient la nouvelle référence.

- `onDeleted()` (ligne 437) et `onUninit()` (ligne 433) laissent donc une chaîne orpheline qui
  continue d'interroger l'onduleur en SNMP et d'appeler `setCapabilityValue()` sur un appareil
  détruit, **jusqu'au redémarrage de l'app**.
- `onSettings()` (ligne 424) fait `clearTimers()` puis `scheduleLive()` : si un relevé court, on se
  retrouve avec **deux chaînes**, et une de plus à chaque changement d'intervalle.

**Pourquoi ça compte.** La fenêtre n'est pas étroite : un relevé dure jusqu'à 5 s en v2c (2 500 ms
× 2 tentatives) et jusqu'à 35 s en v1 (constat 2) pour un rythme de 10 s. Sur un onduleur lent ou
muet, un relevé est **presque toujours** en vol.

**Correctif.** Un jeton de génération, testé avant de replanifier :

```ts
private generation = 0;
private clearTimers(): void { this.generation += 1; /* … */ }
private scheduleLive(gen = this.generation): void {
  if (gen !== this.generation) return;
  this.liveTimer = this.homey.setTimeout(() => {
    void this.pollLive().finally(() => this.scheduleLive(gen));
  }, intervalMs(this.readSettings().liveInterval, LIVE_RHYTHM));
}
```

Et le même dans `onInit()` (lignes 108-109), dont les deux `.finally()` amorcent les chaînes.

---

## 4. 🟠 Le champ `host` des réglages contourne le contrôle d'identité de la réparation

**Déduit à la lecture.** `drivers/ups/driver.settings.compose.json` expose `host` en texte libre.
`onSettings()` (`device.mts:401-431`) reconstruit le client, remet le lecteur à `null`, et relève —
sans jamais comparer le numéro de série.

`onRepair()` (`driver.mts:332-366`) fait tout l'inverse, et pour une raison écrite noir sur blanc à
la ligne 315 : « pointer une réparation sur la machine voisine ne lève rien, ne se voit jamais ».
Cette garantie tombe dès que l'utilisateur passe par la page de réglages, qui est le chemin le plus
naturel pour corriger une IP.

**Correctif.** Dans `onSettings()`, quand `host` change : sonder la nouvelle adresse et comparer à
`getStoreValue('serial')`. `onSettings` peut **jeter** pour refuser le changement, et son type de
retour (`Promise<string | void>`) permet de rendre le message affiché à l'utilisateur. À défaut,
`setUnavailable()` avec le message d'identité plutôt qu'un relevé silencieux du voisin.

---

## 5. 🟡 Stratégie de découverte déclarée, aucun handler côté device

**Déduit à la lecture**, corroboré par les types du SDK.

`driver.compose.json:17` déclare `"discovery": "ups"`, et `app.json` porte bien la stratégie MAC
(18 préfixes OUI). Le driver s'en sert au pairing (`driver.mts:403`). Mais `UpsDevice` n'implémente
**ni** `onDiscoveryResult`, **ni** `onDiscoveryAvailable`, **ni** `onDiscoveryAddressChanged`.

`node_modules/@types/homey/lib/Device.d.ts:299` : « By default, the method will match on a device's
`data.id` property. » Or `data.id` vaut ici `synology:serial:…` / `apc:id:…` (`pairing.mts:118-132`)
et l'`id` d'un `DiscoveryResultMAC` est une adresse MAC : **le matcher par défaut ne peut jamais
correspondre**. Les hooks de découverte sont donc inertes pour tous les appareils.

**Pourquoi ça compte.** L'app stocke déjà la MAC (`store.mac`, `pairing.mts:102`) et la stratégie
rapporte la nouvelle adresse de cette MAC après un bail DHCP. La panne que `repair.html` existe pour
réparer à la main est **auto-réparable**, et le SDK l'offre gratuitement.

**Correctif.** Dans `device.mts` :

```ts
override onDiscoveryResult(r: Homey.DiscoveryResultMAC): boolean {
  return String(r.mac ?? '').toLowerCase() === String(this.getStoreValue('mac') ?? '').toLowerCase()
    && this.getStoreValue('mac') != null;
}
override async onDiscoveryAddressChanged(r: Homey.DiscoveryResultMAC): Promise<void> {
  await this.setSettings({ host: r.address });   // sur changement — pas par tick, §8.6 tenu
  this.buildClient();
}
```
Sans MAC en store (tous les appareils issus du balayage, `driver.mts:522`), rendre `false` :
le rattrapage manuel reste la voie.

---

## 6. 🟡 `refreshNow()` peut ne rien faire, et le dit à personne

**Déduit à la lecture.** `refreshNow()` (`device.mts:366`) appelle `pollLive()`, qui passe par
`liveGate.run()`. `PollGate.run()` (`poll-engine.mts:74-83`) rend `false` quand un relevé court
déjà — et les deux valeurs de retour sont ignorées. La carte Flow « relever maintenant »
(`driver.mts:176-180`) rapporte donc un succès pour une action qui n'a rien fait. Avec les durées
du constat 2, c'est loin d'être rare.

**Correctif.** Propager le booléen et, quand il vaut `false`, soit attendre le relevé en cours, soit
jeter — une carte Flow qui échoue est visible dans le timeline de Homey, un no-op ne l'est pas.

---

## 7. 🟡 `probeAnnounced()` n'est pas gardé : « Rechercher à nouveau » en empile une copie

**Déduit à la lecture.** `driver.mts:247` lance `void this.probeAnnounced(community)` à **chaque**
`scan_start`. La vue rend le bouton « Rechercher à nouveau » (`start.html:429`), et chaque appui
démarre une nouvelle boucle séquentielle qui écrit dans `this.discovered` et `this.silent` pendant
que la précédente tourne encore. `dedupeByHost()` masque les doublons, mais les sondes SNMP, elles,
se cumulent — sur le même réseau qu'un balayage de 254 adresses.

`onPair()` (lignes 224-225) remet ces deux champs à zéro : une boucle héritée d'une session
précédente écrit dans l'état de la nouvelle.

**Correctif.** Un drapeau `probing` autour de `probeAnnounced()`, remis à zéro dans son `finally`,
comme `sweeping` côté vue.

---

## Les neuf pannes du rétro — état réel dans le code

Vérifié par lecture du HTML et des handlers, pas des commentaires.

| # | Panne | État | Preuve |
|---|---|---|---|
| 1 | `<script src="/homey.js">` en double | ✅ | Aucune balise dans `pair/start.html` ni `pair/repair.html`. La page de *settings* l'inclut bien (`settings/index.html:1`) — les deux conventions sont correctement distinguées. |
| 2 | Appel avant `Homey.ready()` | ✅ | `Homey.ready()` est le premier appel des deux vues (`start.html:605`, `repair.html:199`), dans un `try`, avec repli synchrone si le retour n'est pas une promesse. Aucun `Homey.setTitle`. |
| 3 | `onHomeyReady` en pairing | ✅ | Absent des deux vues ; présent uniquement dans `settings/index.html:72`, où c'est la bonne convention. |
| 4 | `session.showView()` depuis un handler | ✅ | Aucune occurrence hors commentaires et tests. |
| 5 | Vue custom → template système | ✅ | `driver.compose.json` : `"pair": [{"id":"start"}]`, une seule vue, qui appelle `Homey.createDevice()` puis `Homey.done()` (`start.html:371-383`). Aucun `list_devices`. |
| 6 | Clé non admise dans un résultat de pairing | ⚠️ | La forme est juste et doublement gardée (type `PairingDevice` + `PAIRING_RESULT_KEYS`), mais elle est **incomplète** : `capabilities` et `capabilitiesOptions` manquent — voir constat 1. La panne est donc évitée dans sa forme littérale, et son effet (un appareil inutilisable, sans un mot) présent par une autre porte. |
| 7 | Vues partageant document et portée globale | ✅ | IIFE dans les deux vues ; tous les identifiants préfixés `ups-start-` / `ups-repair-` ; aucun symbole global. |
| 8 | Course à l'amorçage | ✅ | Toutes les affectations (`var …El`, `adopting`, `sweeping`) précèdent l'appel à `ready()` ; `boot()` est une déclaration hoistée ; les deux chemins (`ready` thenable ou non) mènent au même `boot`. |
| 9 | `session.emit()` en push | ✅ | Aucun. Tout est en requête/réponse `Homey.emit()` + interrogation à 1,5 s (`start.html:442-460`), avec abandon après 30 passes. |

**Le §8.2 (10 s) est tenu pour le balayage** — `startScan()` rend la main aussitôt et un second appel
retourne celui en vol (`app.mts:199-200`) — **et cassé pour la sonde d'adresse en v1** (constat 2).

**Le §8.6 (aucune écriture persistante par tick) est tenu** : `setStoreValue` n'apparaît que dans
`ensureReader()` (une fois, sur détection réussie) et dans la réparation ; `setSettings` jamais dans
la boucle ; `setAvailable`/`setUnavailable` sont gardés par `getAvailable()`
(`device.mts:278-298`). Seul `setCapabilityValue` est appelé par tick, ce qui est l'usage attendu.

---

## Ce que je n'ai pas trouvé

Rien à signaler sur : la discipline des handlers de pairing, la forme requête/réponse, l'absence de
`set()` SNMP, le découpage `device.mts` / `poll-engine.mts` / `pairing.mts` (qui est ce qui rend la
mécanique testable), l'annulation des timers via `this.homey.setTimeout`, l'amorçage non bloquant de
`onInit()`, et la déclaration d'API (`app.json` → les quatre exports d'`api.mts` concordent).
