# Revue de sécurité — app Homey « SNMP - Network Devices »

**Rôle : security-reviewer. Angle : surface d'attaque et traitement des secrets** (la community
SNMP, le balayage de sous-réseau, la validation des entrées de pairing, l'injection DOM dans les
vues HTML, le simulateur en production).

Méthode : lecture de `lib/snmp/`, `lib/ups/`, `drivers/ups/`, `app.mts`, `api.mts`,
`settings/index.html`, `.homeycompose/app.json`, `.homeyignore`, `package.json`. Vérifié en
exécutant : `npx tsc --noEmit` (passe, aucune erreur). Le reste est déduit à la lecture, comme
indiqué à chaque constat.

---

## 1. La community choisie au balayage est silencieusement perdue à l'adoption (chemin principal)

**Le problème.** `drivers/ups/driver.mts:517-528`, méthode `fromScan()` :

```ts
device: buildCandidate({
  host: found.host,
  source: found.source,
  version: 'v2c',
  community: 'public',   // 🔴 codé en dur
  ...
}).device,
```

`fromScan()` construit la charge utile de pairing pour **tout appareil trouvé par le balayage
automatique** — c'est-à-dire le chemin que la vue emprunte en premier : `boot()` appelle `sweep()`
immédiatement (`pair/start.html:590`), qui envoie la community réellement saisie
(`scan_start({community: community()})`), et `app.startScan()` l'utilise bien pour interroger le
réseau (`app.mts:236`). Mais quand `driver.mts` retraduit `state.found` en candidats à adopter, il
ignore la community qu'il vient lui-même de recevoir et écrit `'public'` en dur.

À comparer avec `fromProbe()` (ligne 459), qui elle reçoit `community` en paramètre et la propage
correctement — c'est le chemin de la sonde manuelle (« Test this address »), pas celui du balayage.

**Pourquoi ça compte.** La community est le seul secret de cette app (`.omc/plans/autopilot-impl.md`
§3.7bis, `driver.settings.compose.json:19` — type `password`). Un utilisateur qui a
délibérément changé la valeur par défaut pour raisons de sécurité — précisément celui à qui ce détail
importe — voit son appareil adopté avec `community: "public"` au lieu de la sienne, **sans un mot**.
Au premier relevé, `device.mts:136` construit le client SNMP avec ce réglage faux : soit l'appareil
répond quand même parce que `public` est aussi accepté en parallèle (mauvaise nouvelle inverse : la
community privée n'a servi à rien), soit il ne répond plus du tout et l'utilisateur se retrouve avec
un onduleur « injoignable » sans lien évident avec la community qu'il avait pourtant bien tapée à
l'écran.

C'est aussi une panne invisible aux tests : `fromScan()` vit dans `UpsDriver`, qui « ne s'instancie
pas hors du runtime Homey » (commentaire en tête de `pairing.mts`), donc hors de portée de
`test/drivers/pairing.test.mts` — lequel couvre `buildCandidate()` correctement (test ligne 53-54)
mais jamais `fromScan()`.

**Le correctif précis.** `drivers/ups/driver.mts:517-528` — remplacer `community: 'public'` par la
community du scan en cours. `fromScan()` doit recevoir ce paramètre (comme `fromProbe()` le reçoit
déjà) ; son unique appelant, `scan_status` (ligne 269), la connaît : c'est la valeur passée à
`scan_start` puis à `app.startScan()`, à conserver le temps du balayage (par exemple à côté de
`this.discovered`/`this.silent`).

---

## 2. `POST /probe` n'a aucune borne de concurrence, contrairement à `POST /scan`

**Le problème.** `app.mts:199`, `startScan()` refuse un second balayage tant qu'un premier tourne
(`if (this.scan.running) return this.getScanState();`). `probeAddress()` (ligne 345) n'a aucune garde
équivalente : chaque appel ouvre, sans plafond, une négociation de version (jusqu'à 2 sessions SNMP),
jusqu'à 3 sondes de dialecte, une lecture d'identité, et — si tout échoue — 4 connexions TCP
(`isReachable`, `REACHABILITY_PORTS`). Rien n'empêche des appels concurrents à `POST /probe`
(`api.mts:137`, rôle `owner` mais sans limite de fréquence) de s'empiler.

**Pourquoi ça compte.** Homey a un nombre de descripteurs de fichiers limité (c'est explicitement la
raison de `DEFAULT_CONCURRENCY = 24` dans `scan.mts:25`). Une page settings ou une vue de pairing qui
réémettrait `/probe` en rafale — bug côté client, ou onglet dupliqué — peut faire grimper la
consommation de sockets sans plafond, à un moment où le balayage partagé tourne peut-être déjà en
parallèle. C'est un risque d'épuisement de ressources local, pas un accès non autorisé : sévérité
modérée, mais absente de toute garde alors que le code voisin (`startScan`) montre que le risque est
déjà pris au sérieux ailleurs.

**Le correctif précis.** `app.mts`, `probeAddress()` : soit une garde de type sémaphore/compteur
d'appels en vol, soit — plus simple — laisser `api.mts` sérialiser `postProbe` (une seule sonde à la
fois), sur le modèle de ce qui existe déjà pour `postScan`.

---

## 3. Aucune restriction de portée sur l'adresse sondée

**Le problème.** `hostOf()` (`pairing.mts:201`) et le corps de `postProbe` (`api.mts:139`) ne valident
que « ce n'est pas vide » : ni forme d'IPv4, ni restriction aux plages privées. `probeAddress()` fait
ensuite parler l'app à cette adresse en UDP (SNMP) et, en repli, en TCP sur quatre ports
(`app.mts:429-458`). Le balayage automatique, lui, est borné par construction (le `/24` déduit de
`homey.cloud.getLocalAddress()`), mais la sonde manuelle et `setAddress` en réparation acceptent
n'importe quelle chaîne.

**Pourquoi ça compte.** Sévérité faible : c'est le rôle assumé de cette fonctionnalité (l'utilisateur,
déjà `owner` sur l'app, demande explicitly qu'on interroge une adresse), et Homey ne propose pas
d'API pour distinguer LAN et WAN. Mais c'est la question posée par le brief, et la réponse est : non,
rien n'empêche de pointer la sonde — ou une réparation — vers une adresse hors du réseau local
de l'utilisateur. À noter, pas nécessairement à corriger en v1.

---

## 4. Le balayage est borné, mais pas interruptible

**Vérifié à la lecture.** `scan.mts:99-103` énumère exactement les 254 adresses d'un `/24` moins les
hôtes déjà appairés — pas d'expansion possible depuis l'API (`postScan` n'accepte que `community`, pas
de sous-réseau). Concurrence plafonnée à 24 (`DEFAULT_CONCURRENCY`), timeout de 1,5 s par sonde sans
retry : le balayage est borné dans le temps par construction.

Il n'est en revanche **pas interruptible** : une fois `void scanSubnet(...)` lancé (`app.mts:234`),
rien dans `app.mts`, `driver.mts` ni `api.mts` ne peut l'arrêter avant sa fin naturelle — pas de
`scan_cancel`, pas de `AbortController`. Fermer la vue de pairing, quitter le driver ou changer de
réseau ne coupe rien : le balayage continue en tâche de fond jusqu'à son terme (~16 s), ce qui est
inoffensif ici vu la borne déjà en place, mais mérite d'être noté puisque le brief pose la question
explicitement. Sévérité informative.

---

## Ce qui est solide (vérifié, pas déduit)

- **Community masquée dans les réglages.** `driver.settings.compose.json:19` : `"type": "password"`
  sur `community`, conforme à la décision du plan §3.7bis. Vérifié dans le fichier compose *et* dans
  `.homeycompose/app.json` généré.
- **Community absente du tampon de traces.** Chaque site qui écrit dans `trace` avec une community en
  contexte la masque explicitement (`driver.mts:240` : `community === 'public' ? 'public' :
  '(personnalisée)'`) ou ne la mentionne pas du tout (`app.mts`, `scan.mts`). `GET /trace` ne peut
  donc pas la révéler. Vérifié par grep exhaustif de `community` dans `lib/` et `drivers/` : aucun
  autre site d'écriture.
- **Escaping DOM cohérent.** Les trois vues qui manipulent `innerHTML`
  (`settings/index.html`, `pair/start.html`, `pair/repair.html`) font systématiquement passer tout
  contenu dynamique — y compris ce qu'un agent SNMP distant (donc potentiellement hostile) fournit
  dans `sysDescr`/`sysName`, et y compris après substitution de jeton `{{host}}` — par une fonction
  `escapeHtml`/`esc` avant insertion. Vérifié ligne par ligne sur les trois fichiers ; aucun point
  d'insertion non échappé trouvé. Les messages d'erreur passent par `.textContent`, pas `.innerHTML`.
- **Endpoints API en `role: "owner"`.** Les quatre routes (`getTrace`, `getScan`, `postScan`,
  `postProbe`) portent `"role": "owner"` dans `.homeycompose/app.json` et `app.json` — aucune n'est
  `public`. Vérifié en lisant les deux fichiers.
- **Le simulateur ne peut pas partir en production.** `tools/` est exclu du paquet par
  `.homeyignore:7`, et aucun script `package.json` ne l'invoque (`build`/`typecheck`/`test`/`validate`
  seulement) : il ne se lance que par une commande `node tools/synology-ups-sim.mjs` tapée à la main.
  Vérifié en lisant `.homeyignore` et `package.json`.
- **Décodage `Opaque Float` sans dépassement.** `opaque.mts:28-36` vérifie la longueur du buffer avant
  tout accès indexé ; un agent malveillant qui répond avec un `Opaque` malformé rend `null`, jamais un
  crash ni une lecture hors bornes.

## Ce qui n'a pas été creusé

Le contrôle d'accès Homey lui-même (session `owner`, CSRF sur l'API app locale) est hors périmètre :
c'est une garantie du socle SDK, partagée par toute app Homey, pas un choix de ce dépôt.
