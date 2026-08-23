# Plan — App Homey « Network UPS » (`com.dataweavelabs.netdevices`)

État : **phase 1 terminée**. Annexe A (référence OID) livrée et vérifiée.
Portée : plan seul — **aucun code écrit**.

⚠️ **Ce plan n'a pas eu de passe de revue indépendante.** L'agent critique a été lancé deux fois et n'a
rien produit. Les défauts corrigés en cours de route (§3.7 portée du pairing, §2 règle de nommage, §3.8
mort de la source pendant la coupure, §4.2 bis un point SNMP ≠ un device, §3.1 bis SNMP désactivé par
défaut) l'ont été par auto-relecture, ce qui n'équivaut pas à un regard adverse. À refaire avant le
premier commit.

**Deux réserves non levées, portées par l'auteur du plan :**
1. Le socle poll à 300 s ; ici ce sera ~10 s, soit **30× le churn de sockets UDP**, sur matériel Homey
   contraint et **sans mesure à l'appui**. À instrumenter au lot 5.
2. **Aucun chiffre** sur la proportion d'utilisateurs Homey ayant Synology + onduleur USB + SNMP activé.
   Le pari est raisonné, pas mesuré.

---

## 1. Le problème qu'on résout

Sur le forum Homey, le fil « Anyone using the APC app successfully? » est **ouvert depuis septembre 2018 et
toujours en échec en juillet 2026**. Le symptôme récurrent sur huit ans est toujours le même : *« No new
devices found »*, *« communication error »*. L'app APC existante impose soit un démon `apcupsd` à installer
et configurer sur une machine Linux tierce, soit une carte réseau dans l'onduleur. L'app NUT (`se.nut`)
impose un serveur NUT. Aucune des deux ne trouve l'appareil toute seule.

**La demande n°1 jamais satisfaite est : « mon onduleur est branché sur mon Synology ».**

C'est la même thèse que `homey-netprinter`, appliquée à une autre classe : une MIB standard, un driver,
toutes les marques, et une découverte qui pose à chaque adresse la question exacte que l'app posera ensuite.

### Le besoin est mesurable, même sans chiffre de parc

Le fil **« Power outage detection solution »** (2019→2021, **38 messages, 5 483 vues**) montre l'état de
l'art côté utilisateurs Homey pour détecter une coupure de courant :

- une astuce de pince ampèremétrique reposant sur le fait que la dernière valeur reste figée quand le
  capteur perd son alimentation ;
- ou, solution finalement retenue et illustrée en photos, **câbler un relais Finder 240 V**.

Et l'auteur ouvre par : *« Both router and Homey is backed up with UPS »*. Autrement dit **le public
visé possède déjà un onduleur** — il lui manque seulement un moyen logiciel de l'interroger, et il en
est réduit à du câblage.

⚠️ Ce que ça mesure et ce que ça ne mesure pas : ça établit la **demande** pour la fonction et la
**possession d'un onduleur** dans le public Homey. Ça n'établit **pas** la part de ces utilisateurs
équipés d'un Synology — la réserve n°2 en tête de document reste entière.

### Le cadrage marché, honnêtement

Un onduleur ne parle SNMP que par une carte réseau (~200 €, rare chez un particulier). Le chemin d'accès
réellement fréquent est donc **le NAS qui relaie l'onduleur USB**. Synology expose son onduleur en SNMP sous
`SYNOLOGY-UPS-MIB` (`1.3.6.1.4.1.6574.4`, `upsBatteryChargeValue` = `…4.3.1.1.0` confirmé).

⇒ **Le relais NAS n'est pas le plan B, c'est le chemin principal.** Cela inverse l'ordre d'implémentation
par rapport à ce que j'avais proposé au départ, et c'est le point le plus important du plan.

---

## 2. Décisions de cadrage

| Décision | Choix | Motif |
|---|---|---|
| Périmètre v1 | **Driver onduleur seul** | Livrer. L'architecture est multi-drivers dès le jour 1, le 2ᵉ driver coûte alors peu. |
| Drivers suivants | PDU, switch/PoE, NAS/hôte | Dans cet ordre de valeur décroissante. |
| Imprimante | **reste dans `homey-netprinter`** | App publiée, bien nommée, déjà passée en review. On ne la fusionne pas. |
| Catégorie store | **`energy`** (pas `tools`) | Un onduleur relève de l'énergie ; netprinter est en `tools`, ce qui est correct pour lui. |
| **Nom** | **« Network UPS »** | 🔴 Les règles du store **interdisent les noms de protocole** (« Zigbee, Z-Wave, 433 MHz, Infrared etc. ») : « SNMP » serait **refusé en review**. Et 4 mots maximum. « Network UPS » calque « Network Printer », fait 2 mots, et maximise la découvrabilité du public v1. |
| **Id** | **`com.dataweavelabs.netdevices`** ✅ *décidé* | Immuable. Couvre les **quatre** drivers de la feuille de route — onduleur, PDU, switch/PoE, NAS — là où un id « power » n'aurait couvert que les deux premiers. L'interdiction des noms de protocole ne vise que le nom affiché, pas l'id. |
| Renommage ultérieur | « Network Power » quand PDU/switch arrivent | Le **nom** est une donnée de version et peut évoluer ; l'**id** non. D'où id large + nom précis aujourd'hui. |
| Découvrabilité | `tags` chargés de marques | La doc Athom confirme que `tags` est **indexé par la recherche du store** : `apc, eaton, riello, cyberpower, socomec, synology, qnap, onduleur, ups, nas`. |
| Plateforme | `local` uniquement | SNMP est du LAN. |
| Compatibilité | `>= 12.0.1` | Imposé : app ESM. |

### Décisions arrêtées

| # | Décision | Choix |
|---|---|---|
| 1 | Nom affiché | **« Network UPS »** — contraint par les règles du store (noms de protocole interdits, 4 mots max) |
| 2 | App id (immuable) | **`com.dataweavelabs.netdevices`** |
| 3 | Code partagé | **Recopie**, avec un test qui échoue en cas de divergence ; extraction vers npm une fois le socle stabilisé |
| 4 | Dépôt | **Nouveau dépôt séparé.** `homey-netprinter` n'est pas touché : il est publié et stable, et il reste la **copie canonique** du socle, parce qu'elle est éprouvée. La nouvelle app recopie depuis lui. |

---

## 3. Le driver onduleur

### 3.1 Quatre sources, un seul driver

L'app sonde dans cet ordre et s'arrête à la première qui répond. **Vérifié : les quatre existent.**

| # | Source | Base | Statut |
|---|---|---|---|
| 1 | **`SYNOLOGY-UPS-MIB`** — onduleur USB relayé par un NAS Synology | `1.3.6.1.4.1.6574.4` | ✅ **confirmé faisable**, cas majoritaire |
| 2 | **`UPS-MIB` / RFC 1628** — carte réseau d'onduleur, tous constructeurs | `1.3.6.1.2.1.33` | ✅ standard |
| 3 | **`PowerNet` APC** — repli quand une carte APC répond mal à la RFC | `1.3.6.1.4.1.318.1.1.1` | ✅ confirmé |
| 4 | QNAP | `1.3.6.1.4.1.55062.1.13` | ⚠️ **incertain — au mieux, pas dans le périmètre engagé** |

C'est exactement le motif `vendors.mts` de netprinter : un socle standard, des profils par-dessus.

**Ce que l'utilisateur Synology doit faire** : activer SNMP dans DSM et avoir configuré son onduleur USB.
Deux cases à cocher. **Il n'installe ni ne configure NUT** — DSM s'en charge. C'est précisément ce que
l'app APC n'a jamais su faire en huit ans.

**Hors périmètre, et il faut le dire dans le README** : un Linux générique avec NUT n'expose **rien** en
SNMP sans pont tiers (`nut-snmpagent`). NUT n'a pas d'agent SNMP.

### 3.1 bis — Le prérequis utilisateur est *le* problème, pas un détail

Les deux chemins exigent que l'utilisateur **active quelque chose**, et c'est là que les apps
concurrentes meurent :

| Chemin | Ce que l'utilisateur doit activer |
|---|---|
| Synology | SNMP dans DSM (Panneau de configuration → Terminal & SNMP) **et** l'onduleur USB configuré (Matériel & Alimentation → UPS) |
| Carte réseau APC | 🔴 **SNMP est désactivé par défaut sur les firmwares NMC récents** — v1 *et* v3. Il faut l'activer explicitement, et la découverte par plage d'IP exige SNMPv1 avec la community `public` |

C'est **exactement** le symptôme du fil APC ouvert depuis 2018 : *« No new devices found »*. L'app ne
trouve rien parce que rien n'est activé, et **elle ne le dit pas**.

⇒ **Décision produit.** Quand le balayage ne trouve rien, le pairing n'affiche pas « aucun appareil
trouvé » mais **ce qu'il faut aller activer**, avec le chemin exact dans DSM ou dans l'interface de la
carte. Et quand une adresse répond en ICMP mais pas en SNMP, on le distingue explicitement : « cet
appareil est joignable mais ne répond pas en SNMP — le service est probablement désactivé ».

C'est peu de code et c'est probablement le premier différenciateur réel de l'app.

### 3.1 ter — SNMPv3 : absent, et acceptable

`snmp-client.mts` déclare v3 hors périmètre (`SnmpVersion = 'v2c' | 'v1'`). Vérifié : ce n'est **pas**
rédhibitoire — DSM propose v1/v2c en case à cocher distincte de v3, et une carte APC accepte v1/v2c une
fois SNMP activé. Cela exclut en revanche l'utilisateur qui fait tourner du v3 exclusivement par
principe — une part non nulle du public homelab visé.

⇒ Hors v1, mais **au feuille de route**, et à dire dans le README plutôt qu'à laisser découvrir.
`net-snmp` gère v3 nativement : l'ajout reste contenu au client.

### 3.2 Capabilities — mapping concret

Voir **annexe A** pour les OID exacts. Le mapping ci-dessous en découle directement.

| Capability | Synology (primaire) | RFC 1628 | APC | Transformation |
|---|---|---|---|---|
| `measure_battery` (%) | `upsBatteryChargeValue` | `upsEstimatedChargeRemaining` | `upsAdvBatteryCapacity` | **Synology : Opaque Float** |
| `ups_runtime` (min) | `upsBatteryRuntimeValue` | `upsEstimatedMinutesRemaining` | `upsAdvBatteryRunTimeRemaining` | **÷60 / rien / ÷6000** — 4 unités, cf. §6d |
| `ups_load` (%) | `upsInfoLoadValue` | `upsOutputPercentLoad.1` | `upsAdvOutputLoad` | Synology : Opaque Float |
| `ups_status` (enum) | `upsInfoStatus` (**chaîne NUT**) | `upsOutputSource` (7 val.) | `upsBasicOutputStatus` (**28 val.**) | trois dialectes → un vocabulaire |
| `measure_voltage.input` | — | `upsInputVoltage.1` | `upsAdvInputLineVoltage` | volts entiers, **pas** de division |
| `measure_voltage.output` | `upsBatteryVoltageValue` (DC) | `upsOutputVoltage.1` (AC) | — | ⚠️ Synology donne la tension **batterie**, pas la sortie |
| `measure_power` (W) | — | `upsOutputPower.1` | — | absent chez Synology |
| `measure_temperature` | `upsBatteryTemperature` | `upsBatteryTemperature` | `upsAdvBatteryTemperature` | **APC : 255 ⇒ `null`** |
| `alarm_battery` | jeton `LB` | `upsBatteryStatus ∈ {3,4}` | idem | |
| `alarm_ups_onbattery` | jeton `OB` **ou** `DISCHRG` | `upsOutputSource = battery(5)` | `upsBasicOutputStatus = onBattery(3)` | |
| `alarm_ups_overload` | jeton `OVER` | `upsAlarmOutputOverload` | — | |
| `alarm_ups_replace_battery` | jeton `RB` | `upsAlarmBatteryBad` | `upsBasicBatteryStatus = 4` | |

Une capability sans source dans la colonne retenue n'est **pas déclarée** sur ce device — jamais posée à
`null`. (`removeCapability` détruit l'historique Insights de façon irréversible : on ne déclare que ce
qu'on sait lire, dès le pairing.)

**Vocabulaire commun de `ups_status`** (les 7 de la RFC ; les 28 d'APC s'y replient) :
`normal` · `battery` · `bypass` · `booster` · `reducer` · `off` · `unknown`

**Trois pièges qui coûtent une session de debug chacun** (détail en annexe A) :
- Les unités en **dixièmes** (tension batterie, fréquences, courants) — mais **pas** les tensions
  d'entrée/sortie, qui sont en volts entiers. Une erreur ici donne un facteur 10 parfaitement crédible.
- **Trois unités différentes pour « temps restant »** selon la MIB : minutes (RFC), centièmes de seconde
  (APC, CyberPower). À normaliser en minutes dès le lecteur.
- **L'index de table vaut 1, jamais 0** : `...1.5.1`, pas `...1.5.0`, même sur un onduleur monophasé.

**`energy.batteries` : `["INTERNAL"]`** — obligatoire dès qu'on déclare `measure_battery` ou
`alarm_battery`, et ici légitime puisque la batterie est bien dans l'appareil.

**Sous-capabilities** : `measure_voltage.input` / `.output` — Homey **ne génère pas** leurs Flow cards.
À écrire à la main.

`class` du driver : **`sensor`** (cohérent avec netprinter ; la classe conditionne l'agrégation par pièce).

### 3.3 Les Flow cards — c'est là qu'est la valeur domotique

Le scénario cible, celui qui justifie l'app :

> *L'onduleur passe sur batterie → éteindre les appareils non essentiels, notifier, et si l'autonomie
> descend sous 5 minutes, arrêter proprement le NAS.*

**Déclencheurs** : passé sur batterie · secteur revenu · batterie faible · autonomie sous *X* minutes ·
surcharge · batterie à remplacer · état changé
**Conditions** : est sur batterie · autonomie > *X* · charge > *X* %
**Actions** : rafraîchir maintenant · (v2, nécessite le SET) lancer un test de batterie

### 3.4 Polling — deux rythmes

netprinter interroge toutes les 300 s (min. 30 s). **Insuffisant ici** : un passage sur batterie doit
déclencher un Flow en secondes, pas en minutes.

- **Rapide, ~10 s** : état secteur/batterie, autonomie, charge
- **Lent, ~5 min** : identité, tensions, température, compteurs

Motif repris de l'intégration HACS `aburow/ups-snmp-ha`, qui fait exactement ce découpage.

### 3.5 Découverte — résolu par la stratégie MAC

Contrairement à l'imprimante, **pas de mDNS exploitable** : une carte réseau d'onduleur n'annonce rien
d'utile, et un Synology s'annonce, mais pas en tant qu'onduleur.

Homey SDK v3 offre trois stratégies de découverte : `mdns-sd`, `ssdp` et **`mac`**. La stratégie `mac`
cible les **trois premiers octets de l'adresse MAC** (le préfixe OUI du constructeur, en décimal) et
résout l'adresse courante par ARP :

```json
{ "type": "mac", "mac": { "manufacturer": [[0, 192, 181]] } }
```

⇒ **C'est la bonne stratégie pour ce driver.** Elle donne `onDiscoveryAddressChanged`, donc la même
résilience DHCP que netprinter tire de mDNS, sans dépendre d'aucune annonce de l'appareil.

Conséquences concrètes :
- Il faut constituer une **liste d'OUI** : APC / Schneider, Eaton, Synology, QNAP, CyberPower, Riello,
  Socomec, Vertiv. Liste à maintenir — c'est le coût de cette approche.
- Un driver ne référence **qu'une seule** stratégie ⇒ `mac` pour l'onduleur, et le balayage de
  sous-réseau reste le chemin d'adoption initial pour tout ce que les OUI ratent.
- L'appariement doit se faire sur l'**identité SNMP** (numéro de série, `upsIdentModel`), jamais sur
  l'adresse — même règle que netprinter.

### 3.6 Le groupe de contrôle — hors v1, et volontairement

RFC 1628 expose `upsControl` (`.1.8`) **entièrement en écriture** : `upsShutdownAfterDelay`,
`upsRebootWithDuration`, `upsStartupAfterDelay`, `upsAutoRestart`. Et `upsTestId` permet de lancer
`upsTestDeepBatteryCalibration`, **qui décharge profondément la batterie et l'use**.

Autrement dit : une Flow action mal cadrée peut **couper l'alimentation de tout ce qui est branché sur
l'onduleur** — potentiellement le Homey lui-même, la box, le NAS.

⇒ **v1 est en lecture seule, sans exception.** Si le contrôle arrive un jour, il lui faut un garde-fou
explicite (activation par réglage du device, jamais disponible par défaut), et la calibration profonde
ne doit pas être exposée du tout.

### 3.7 Le pairing est lié à un driver — correction et parade

Vérifié dans la doc SDK v3 : **une session de pairing est liée au driver depuis lequel elle démarre**, et
**aucun mécanisme ne permet à un driver de créer un device sur un autre driver**. Les clés admises dans un
résultat de `onPairListDevices()` sont exactement `name`, `data`, `store`, `settings`, `icon`,
`capabilities`, `capabilitiesOptions` — rien d'autre (toute clé en trop vide la liste **silencieusement**).

⇒ L'idée « une IP, l'app détecte les classes et crée tous les devices d'un coup » **ne marche pas telle
quelle**. Un Synology qui est à la fois NAS et relais d'onduleur exige deux passages de pairing, un par
driver.

**Parade — un balayage partagé au niveau app.** Le balayage de sous-réseau et la sonde de classification
vivent dans `app.mts`, pas dans un driver, et leur résultat est mis en cache. Chaque pairing de driver
consomme ce cache et le **filtre sur sa propre classe** :

- 1ᵉʳ pairing : balayage réel (~15 s), l'utilisateur adopte son onduleur.
- 2ᵉ pairing (driver NAS) : liste **immédiate et pré-filtrée**, aucun nouveau balayage.
- Le pairing peut afficher « cet appareil répond aussi en tant que NAS — ajoutez-le depuis le driver NAS ».

On paie donc deux passages, mais le second est instantané et guidé. Cela reste très supérieur aux
intégrations concurrentes, où il faut connaître la marque et l'OID d'avance.

⚠️ Le cache doit respecter la limite des **10 s d'un appel d'API d'app** : le balayage est *lancé* puis
interrogé en polling — mécanisme déjà écrit dans `drivers/printer/driver.mts`
(`scan_start` / `scan_status`), à remonter au niveau app.

### 3.7 bis — Où vivent les secrets, et ce que le socle fait mal aujourd'hui

Une community SNMP est un secret partagé faible, mais c'en est un. `homey-netprinter` la range
aujourd'hui dans un réglage de device de `type: text`, valeur par défaut `public` — donc **affichée en
clair** dans les réglages avancés de l'appareil.

Homey propose un type dédié : « les réglages de type `password` se comportent comme `text`, mais la
saisie est visuellement masquée ». C'est exactement le bon outil, et il ne coûte rien.

⇒ **Décision.** `community` en `type: "password"`. Le réglage reste **modifiable par l'utilisateur** —
indispensable pour dépanner, et c'est pour ça qu'on ne le met pas dans `store`, invisible et
inaccessible sans « Réparation ». Quand SNMPv3 arrivera (§3.1 ter), ses passphrases d'authentification
et de chiffrement suivront la même règle, à plus forte raison.

⇒ **À backporter dans netprinter** au prochain passage : un `type: text` → `password` sur `community`,
sans autre changement.

**Plusieurs clients sur le même onduleur** : sans objet. SNMP est du requête/réponse UDP sans état ;
un agent sert plusieurs interrogateurs simultanés par construction. Un Homey, un NMS type LibreNMS et
un script peuvent cohabiter. Le seul point d'attention est le **débit** — certains firmwares de carte
réseau brident les requêtes — ce que le rythme de 10 s sur trois ou quatre OID ne devrait pas
approcher, mais qui reste à mesurer avec le churn de sockets (réserve n°1).

### 3.8 Le trou logique du relais NAS : la source meurt au pire moment

Le produit existe pour réagir aux coupures de courant. Or, sur le chemin principal, **le capteur est
posé sur l'appareil qu'il surveille** : le Synology est lui-même alimenté par l'onduleur, et DSM
l'éteint après un délai configuré sur batterie (« temps avant passage en mode sans échec »). La source
de données disparaît donc **pendant** l'événement qu'elle sert à détecter.

Déroulé réel d'une coupure :

| t | événement | l'app voit |
|---|---|---|
| 0 s | coupure secteur | — |
| ~10 s | prochain poll rapide | ✅ **`OB` / `DISCHRG` ⇒ déclencheur « passé sur batterie »** |
| 0–N min | autonomie qui décroît | ✅ suivi correct |
| N min | DSM éteint le NAS | ❌ plus rien |
| N+30 s | 3 polls échoués | ⚠️ device indisponible |
| retour secteur | le NAS redémarre | ⏳ « secteur revenu » vu **avec retard**, au boot |

**Ce qui marche** : le déclencheur critique — celui qui coupe les appareils non essentiels — part dans
les dix secondes. C'est l'essentiel de la valeur, et elle est intacte.

**Ce qui ne marche pas** : la fin de l'événement. Et le socle actuel traiterait ça comme une banale
injoignabilité, alors que c'est une **information** : perdre le contact *alors que le dernier état connu
était « sur batterie »* signifie que la coupure a duré assez pour éteindre le NAS.

⇒ **Décision de conception.** Le device distingue deux pertes de contact :
- injoignable depuis un état normal ⇒ comportement actuel (indisponible après 3 échecs) ;
- injoignable **alors que le dernier état connu était `battery`** ⇒ déclencheur distinct
  « contact perdu pendant une coupure », et l'état reste **figé** sur `battery` au lieu de basculer en
  `offline`. On ne prétend pas savoir que c'est revenu.

⇒ **À dire dans le README, pas à cacher** : sur le chemin NAS, l'app voit le début d'une coupure, pas sa
fin. Le chemin carte réseau (RFC 1628) n'a pas cette limite — la carte est alimentée par l'onduleur et
vit aussi longtemps que lui. C'est l'argument honnête pour qui veut la surveillance complète.

---

## 4. Architecture

### 4.1 Ce que netprinter fournit déjà, et à quel titre

| Fichier | l. | Nature | Destin |
|---|---|---|---|
| `lib/snmp-client.mts` | 228 | **générique SNMP pur** — aucune notion d'imprimante | partagé tel quel |
| `lib/network-scan.mts` | 151 | générique réseau ; seule la **question de sonde** est spécifique | partagé, la sonde devient un paramètre |
| `lib/capability-map.mts` | 151 | spécifique imprimante, mais le **motif** est générique (aucun import Homey ⇒ testable seul) | motif repris, contenu réécrit |
| `lib/vendors.mts` + `vendors/` | 77 | motif générique de profils par constructeur | motif repris |
| `lib/printer-mib.mts` | 225 | spécifique | reste |
| `lib/printer-reader.mts` | 214 | spécifique | reste |
| `drivers/printer/device.mts` | 350 | **mécanique générique** : garde de réentrance, replanification, seuil d'échecs avant indisponibilité, déclenchement sur changement, isolation par capability | classe de base partagée |
| `drivers/printer/driver.mts` | 322 | pairing `scan_start`/`scan_status`/`probe`/`adopted` + tampon `viewLog` | mécanique partagée |

Trois points à décontaminer, précisément :

1. **`network-scan.mts`** interroge chaque adresse avec la question imprimante. La sonde doit devenir un
   paramètre : `probe(host): Promise<DeviceClass[] | null>`.
2. **`device.mts`** n'a **qu'un seul rythme** de poll (`scheduleNextPoll()`, 300 s, plancher 30 s).
   Il en faut deux (§3.4). Généralisation : la classe d'appareil déclare `pollGroups`, chacun avec sa
   période et son jeu d'OID ; le socle planifie un timer par groupe, chacun gardé contre la réentrance.
3. **La stratégie de découverte est présumée mDNS.** Elle devient un paramètre de la classe d'appareil :
   `_ipp._tcp` pour l'imprimante, `mac` + liste d'OUI pour l'onduleur (§3.5).

### 4.2 Le contrat de classe d'appareil

```ts
interface DeviceClassSpec<TSnapshot> {
  id: string;                                    // 'ups', 'pdu', 'switch', 'nas'
  /** Répond « cet appareil est-il de ma classe ? » — une lecture SNMP, jamais plus. */
  probe(client: SnmpClient): Promise<ProbeVerdict | null>;
  /** Les sources possibles, essayées dans l'ordre : Synology, RFC 1628, APC… */
  sources: readonly SourceProfile<TSnapshot>[];
  /** Groupes de poll, chacun avec sa période. */
  pollGroups: readonly { id: string; seconds: number; read(...): Promise<Partial<TSnapshot>> }[];
  /** Snapshot → capabilities. Aucun import Homey : testable sans Homey qui tourne. */
  map(snapshot: TSnapshot): CapabilityPlan;
  discovery: { type: 'mdns-sd'; name: string } | { type: 'mac'; oui: number[][] };
}
```

Le socle fournit : session SNMP, réessais, planification multi-rythmes, résilience d'adresse,
seuil d'indisponibilité, tampon de traces, cache de balayage. La classe ne fournit que du **savoir**.

### 4.2 bis — Un point SNMP ≠ un device Homey

Le contrat ci-dessus suppose implicitement **une adresse IP = un device**. C'est vrai pour l'onduleur et
l'imprimante ; **c'est faux dès le PDU**. Un PDU à 24 prises n'est pas un device à 24 capabilities :
Homey n'a aucune bonne représentation de ça sur une tuile, chaque prise doit vivre dans une pièce et
porter son nom (« Prise NAS »), et surtout **les Flow cards de `onoff` sont générées par device, pas par
sous-capability** — or on sait déjà (§3.2) que les sous-capabilities n'en obtiennent aucune.

⇒ **Une prise = un device** de classe `socket`, avec `onoff` et `measure_power`. C'est permis : un
pairing peut renvoyer plusieurs devices, **du moment qu'ils appartiennent au même driver** (§3.7), et
chacun porte son propre `data.id` tout en partageant l'hôte dans ses `settings`.

Pour un switch 48 ports, créer 48 devices serait absurde. Le pairing **liste les ports et l'utilisateur
coche ceux qui l'intéressent** — le même principe que le choix des sources : l'app propose ce qu'elle a
trouvé, l'utilisateur retient ce qui compte. Plus, éventuellement, un device d'agrégat pour le switch
lui-même (conso PoE totale, seuil).

Conséquence sur le contrat : `probe()` ne renvoie pas un verdict mais **une liste de candidats**, et
la classe d'appareil déclare combien de devices un point d'accès peut produire.

```ts
probe(client: SnmpClient): Promise<DeviceCandidate[]>;   // 0, 1 ou N
```

**L'onduleur en v1 renvoie toujours exactement un candidat** — ce point n'a donc aucun coût aujourd'hui,
mais l'ignorer maintenant obligerait à réécrire le socle au premier driver PDU.

### 4.3 Le code partagé — recommandation

Contrainte dure : `homey app publish` embarque `node_modules`, et une dépendance `file:` pointant hors du
dossier de l'app ne se résout pas. Il ne reste donc que **publier sur npm** ou **recopier**.

- *Publier* donne la propreté, mais impose publier → bumper → réinstaller **à chaque correction**.
- *Recopier* est immédiat, au prix d'une divergence possible.

**Décidé : recopier pendant la v1, extraire vers npm une fois stabilisé.** Motif : ce qui bouge
souvent (dictionnaires d'OID, lecteurs, mapping) reste **dans l'app** ; le socle partagé (transport,
balayage, décodeur Opaque, tampon de traces) se stabilise vite. On évite ainsi de payer le cycle npm
exactement au moment où l'itération est la plus forte. Un test qui compare les deux copies et échoue en
cas de divergence rend la recopie sûre.

## 5. Lots de travail

Ordre imposé par les dépendances ; ce qui est sur la même ligne est parallélisable.

| Lot | Contenu | Dépend de |
|---|---|---|
| **0** | Socle recopié : `snmp-client`, `network-scan` paramétré, **décodeur `Opaque Float`**, tampon de traces | — |
| **1** | Squelette app : id `com.dataweavelabs.netdevices`, nom « Network UPS », `app.json` d'amorçage, HomeyCompose, `settings/` non vide, images aux bons formats, `compatibility >= 12.0.1` | — |
| **2** | **Lecture Synology** — le chemin principal : OID §6a, décodage Opaque, parseur de jetons NUT | 0 |
| **3** | Lecture RFC 1628 + repli APC : sentinelles, unités en dixièmes, index de table à 1 | 0 |
| **4** | `ups-capability-map` : les trois dialectes → un vocabulaire ; `null` préservé jusqu'à la capability | 2, 3 |
| **5** | Device : deux rythmes de poll, seuil d'indisponibilité, écritures sur changement uniquement | 0, 4 |
| **6** | Pairing : vue unique reprise de netprinter, découverte `mac` + OUI, cache de balayage au niveau app | 0, 1 |
| **7** | Flow cards, **y compris celles des sous-capabilities** que Homey ne génère pas | 4 |
| **8** | Tests : une fixture **par source** avec des valeurs rendant les trois conversions discernables ; JS des vues dans un DOM minimal, sous les deux chemins de démarrage | 2–7 |
| **9** | README, locales fr/en/nl, images du driver, `validate --level publish` | tout |

**Jalon de vérité** : à la fin du lot 2, on doit lire un vrai onduleur sur le Synology. Tant que ce n'est
pas fait sur du matériel réel, tout le reste est spéculatif — c'est la leçon des trois apps précédentes.

## 6. Risques

| Risque | Probabilité | Parade |
|---|---|---|
| ~~Le nom générique coûte la découvrabilité~~ | *résolu, et contraint* | nom de protocole **interdit** par les règles du store ⇒ « Network UPS » + `tags` + catégorie `energy` |
| ~~Pas de résilience DHCP sans mDNS~~ | *résolu* | stratégie de découverte `mac` (OUI), §3.5 |
| ~~Formats Synology inattendus~~ | *confirmé et spécifié* | `Opaque Float` à décoder (10 lignes) + statut = chaîne NUT à parser en jetons — annexe A §6a |
| Le SET (PDU, PoE) déclenche des questions à la review Athom | moyenne | hors v1 |
| Une action de contrôle onduleur coupe le courant du Homey lui-même | **critique si implémenté** | v1 en lecture seule, §3.6 |
| Facteur 10 sur une valeur (unités en dixièmes) | élevée | table de conversion explicite par OID, annexe A |
| **Quatre** unités différentes pour « autonomie restante » selon la source | élevée | normaliser en minutes dès le lecteur, annexe A §6d |
| ~~Marché limité aux onduleurs à carte réseau~~ | *levé* | le relais Synology est confirmé faisable sans NUT |
| QNAP annoncé puis non fonctionnel | moyenne | ne rien promettre sur QNAP en v1 ; tester sur un vrai NAS d'abord |
| L'utilisateur n'a pas activé SNMP et l'app dit juste « rien trouvé » | **élevée — c'est l'échec de l'app APC** | messages de pairing qui disent quoi activer, §3.1 bis |
| Utilisateur en SNMPv3 exclusif | faible-moyenne | documenté, feuille de route, §3.1 ter |
| Liste d'OUI à maintenir (un constructeur absent = pas de résilience DHCP) | moyenne | repli sur le balayage de sous-réseau |
| Deux pairings pour un appareil multi-classes (Synology) | moyenne | cache de balayage partagé au niveau app, §3.7 |
| **La source de données meurt pendant la coupure** (le NAS s'éteint) | **certaine sur le chemin NAS** | déclencheur distinct + état figé, §3.8 ; documenté au README |

## 7. Hygiène — à corriger dans netprinter au passage

**1.** `community` est en `type: text` (donc en clair) et devrait passer en `type: password` — cf. §3.7 bis.

**2.** Un fichier d'état OMC est égaré dans `.homeycompose/capabilities/.omc/state/sessions/…/` :
`pre-tool-advisory-throttle.json`. HomeyCompose scanne ce dossier. À supprimer et à couvrir par `.gitignore`.

---

## 8. Garde-fous issus du rétro des trois apps

Tiré des commits de correction de `homey-netprinter`, `homey-scrypted` et `homey-vtherm`. Toutes ces
pannes ont été trouvées **sur du vrai matériel**, aucune n'était détectable par `npm test` ni par
`homey app validate` : l'un n'exécute pas de HTML, l'autre ne lit pas le JavaScript des vues.

### 8.1 Le pairing est le point de rupture — neuf pannes, zéro message d'erreur

| # | Panne | Cause | Règle |
|---|---|---|---|
| 1 | Emits perdus, page « inerte » | `<script src="/homey.js">` en double ⇒ instance non rattachée à la session | **Jamais** inclure `/homey.js` dans une vue de pairing |
| 2 | Script mort avant sa 1ʳᵉ ligne utile | `Homey.setTitle()` appelé avant `Homey.ready()` | `Homey.ready()` d'abord, puis un log « le script tourne » |
| 3 | **Page blanche** | La vue attendait `onHomeyReady` — convention des **settings**, jamais appelée en pairing | Ne pas transposer une vue de settings en vue de pairing |
| 4 | Session figée, `list_devices` jamais atteint | `session.showView()` appelé depuis le handler `showView` ⇒ deadlock | La navigation appartient à la **vue**, pas au driver |
| 5 | **Écran blanc / assistant fermé sans rien créer** | Vue custom → template système : navigation impossible | Une vue custom **unique** qui crée l'appareil elle-même, ou le template seul |
| 6 | **Liste vide, silencieuse** | Clé non admise (`class`) dans un résultat de pairing ; le SDK type `any[]`, le compilateur ne voit rien | Uniquement `name`, `data`, `store`, `settings`, `icon`, `capabilities`, `capabilitiesOptions` |
| 7 | Une vue remplit la liste **de sa voisine cachée** | **Toutes les vues d'un driver partagent un document ET la portée JS globale** : `getElementById('list')` renvoie celui de la première ; fonctions homonymes et `window.onHomeyReady` écrasés | Scripts encapsulés, identifiants **préfixés par leur vue**, déclarés une seule fois |
| 8 | `{capability: undefined}` reçu comme `{}` | Bug de course : `start()` lisait une constante déclarée mais pas encore affectée — ne se manifestait que si `Homey` était **déjà** prêt | Amorcer après affectation ; tester **les deux** chemins de démarrage |
| 9 | Sweep échoué et événements jamais arrivés indiscernables | `session.emit()` → `Homey.on()`, direction jamais vérifiée | `Homey.emit()` en requête/réponse + polling, jamais du push |

⇒ **Le driver onduleur reprend la vue de pairing de netprinter telle quelle**, qui a déjà payé 1, 2, 5, 9.
Les points **7 et 8 sont neufs pour ce projet** : dès qu'il y aura plus d'une vue par driver
(sonde de classification, puis choix de la source Synology/RFC/APC), ils frapperont.

### 8.2 Les 10 secondes de l'API — déjà résolu, à ne pas re-casser

Un appel à l'API d'une app est coupé à 10 s ; un balayage /24 en prend ~16.
`POST /scan` démarre et rend la main, `GET /scan` rapporte l'avancement, la page interroge toutes les
1,5 s. Un second démarrage pendant qu'un balayage tourne **retourne celui en vol**, il n'en course pas
un deuxième. Tous les autres endpoints sont bornés (2,5 s, sans réessai) — sinon **un seul appareil
éteint pousse la page entière au-delà de la limite**.

⇒ Le cache de balayage partagé du §3.7 hérite de cette forme, il ne la réinvente pas.

### 8.3 L'instrumentation n'est pas optionnelle

Une app installée par CLI **n'a aucun log lisible**. Dans les trois apps, c'est le tampon de traces
servi par `GET /trace` ou `/diagnostics` qui a localisé **chaque** panne — parce qu'il seul distingue
« le driver n'a rien envoyé » de « la vue n'a rien affiché ».

⇒ Le tampon existe **dès le premier commit**, pas après la première panne. Et il reste pour le support.

### 8.4 Ce que les tests ne voient pas — et la parade de vtherm

`npm test` n'exécute pas de HTML ; `homey app validate` ne lit pas le JS des vues ; le SDK type les
résultats de pairing `any[]`. vtherm a fini par **exécuter le JavaScript des vues dans un DOM minimal**,
sous les deux chemins de démarrage. C'est le seul filet qui attrape les pannes 2, 3, 7 et 8.

### 8.5 Deux pièges transposés directement à cette app

**Un `as number` qui ment au compilateur.** Dans vtherm, `lastChangeMs as number` a transformé un `null`
en `0`, déclenchant un keep-alive à chaque redémarrage. Ici, `SnmpValue` vaut
`string | number | Buffer | null` : **un cast qui écrase le `null` donne 0 % de batterie au lieu de
« inconnu »** — et 0 % déclenche `alarm_battery` **et** `alarm_ups_onbattery`. Une fausse alerte de
coupure de courant, en pleine nuit. Le `null` doit rester `null` jusqu'à la capability.

**Une garantie qu'aucun test n'épingle.** Dans vtherm, `minDwellSec` n'était vérifié par aucun test car
toutes les fixtures le réglaient à la valeur plancher : supprimer le `Math.max` laissait la suite verte.
Ici, l'équivalent exact, ce sont les **conversions d'unité**. Si toutes les fixtures d'autonomie valent
60, alors `÷60` (Synology), `÷6000` (APC) et « aucune conversion » (RFC) donnent des résultats qu'un test
mal choisi ne distingue pas. ⇒ **Une fixture par source, avec des valeurs qui rendent les trois
conversions discernables**, et une mutation qui doit faire tomber la suite.

### 8.6 Pas d'écriture persistante dans la boucle de poll

netprinter écrivait les titres de capability à chaque poll : une écriture stockée toutes les 5 minutes,
pour toujours. Corrigé en écriture **sur changement**.

⇒ **Ici c'est plus grave** : le rythme rapide du driver onduleur est de ~10 s (§3.4), soit trente fois
plus. Toute écriture persistante — titre, réglage, `store` — se fait sur changement, jamais par tick.

### 8.7 Ne jamais présumer de la forme d'une valeur tierce

vtherm : une SONOFF TRVZB expose `target_temperature.local` et non `target_temperature` ; la comparaison
exacte rendait invisibles **les cinq vannes que l'app existe pour piloter**. Les détecteurs publient
`alarm_presence` ou `alarm_occupancy`, jamais `alarm_motion`.

⇒ L'équivalent SNMP est déjà identifié en annexe A et n'est pas théorique : `Opaque Float` chez Synology,
statut en chaîne NUT combinable, index de table à `1` et non `0`, sentinelles APC (`255`, `4294967295`).
**Chaque source accepte plusieurs formes, et le lecteur résout celle que l'appareil porte réellement.**
