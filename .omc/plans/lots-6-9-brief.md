# Brief d'exécution — lots 6, 8 et 9

App **« SNMP - Network Devices »** (`com.dataweavelabs.netdevices`).
165 tests passent, `homey app validate --level publish` passe. **Ne rien casser de ça.**

**Déjà fait** : lots 0–5 et 7. Transport, balayage, traces, Opaque Float ; quatre sources
(Synology, RFC 1628, APC) ; mapping des capabilities ; device avec deux rythmes de poll ;
12 cartes de Flow ; README de 115 lignes.

**Reste** : le **pairing** (lot 6) — l'app n'a aujourd'hui `pair: None`, `repair: None`,
`discovery: None`, donc **aucun moyen d'ajouter un appareil**. Puis les tests de vues (lot 8)
et les finitions (lot 9).

**Plan** : `.omc/plans/autopilot-impl.md` — §3.5 découverte MAC, §3.7 portée du pairing,
§3.1 bis les prérequis utilisateur, **§8 les neuf pannes** (à lire deux fois).

---

## Règle absolue de non-collision

| Lane | Écrit **uniquement** dans |
|---|---|
| **G** | `drivers/ups/pair/**`, `test/views/**` |
| **H** | `drivers/ups/driver.mts`, `.homeycompose/discovery/**`, `lib/snmp/oui.mts`, `app.mts`, `api.mts`, `test/snmp/oui.test.mts` |
| **I** | `README.md`, `locales/**`, `settings/**`, `assets/**`, `drivers/ups/driver.settings.compose.json`, `.homeyignore` |

Jamais `git stash`, `git reset`, `git checkout`, `git add -A`. Commit **par pathspec explicite**.
Ne pas toucher `package.json`, `tsconfig*`, `lib/ups/**`, `drivers/ups/device.mts`,
`drivers/ups/poll-engine.mts`. `homey-netprinter` est en **LECTURE SEULE** — on y lit des motifs
éprouvés, on n'y modifie rien.

Vérifier `npm run typecheck`, `npm test` **et** `npx homey app validate --level publish`.

---

## Lane G — la vue de pairing

🔴 **C'est ici que les trois apps précédentes se sont cassé les dents. Neuf pannes, aucune avec le
moindre message d'erreur, aucune détectable par `npm test` ni par `homey app validate`.**
Lire `drivers/printer/pair/` de netprinter : cette vue-là **marche**, elle a payé le prix.

Les règles, chacune achetée par une session de debug :

1. **Jamais `<script src="/homey.js">`** dans une vue de pairing. Homey injecte son API ; une
   seconde copie crée une instance non rattachée à la session et **tous les `emit` partent dans le
   vide**, sans une erreur. (Une page de *settings*, elle, l'inclut bien — ne pas confondre.)
2. **`Homey.ready()` en premier**, avant tout autre appel. Puis immédiatement un log « le script
   tourne » : c'est lui qui distingue « la vue n'a jamais démarré » de « la vue parle dans le vide ».
3. **Pas d'`onHomeyReady`** : c'est la convention des settings, jamais appelée en pairing. Page
   blanche, sans message.
4. **Jamais `session.showView()` depuis le handler `showView`** — deadlock : Homey attend le retour
   du handler, le handler attend la transition.
5. **Une vue custom ne peut pas naviguer vers un template système.** Écran blanc, ou assistant qui
   se ferme sans rien créer. ⇒ **une seule vue custom** qui appelle `Homey.createDevice()` puis
   `Homey.done()`.
6. **Un résultat de pairing n'accepte QUE** `name`, `data`, `store`, `settings`, `icon`,
   `capabilities`, `capabilitiesOptions`. Toute autre clé (`class` par exemple) ⇒ **liste vide,
   silencieusement**. Le SDK type ça `any[]` : le compilateur ne voit rien.
7. 🔴 **Toutes les vues d'un driver partagent UN document ET la portée JS globale.**
   `getElementById('list')` renvoie celui de la **première** vue. Sur vtherm, une page recevait bien
   ses données et **remplissait la liste de sa voisine cachée**. ⇒ scripts encapsulés, identifiants
   **préfixés par leur vue**, déclarés une seule fois.
8. **Bug de course à l'amorçage** : n'amorcer qu'**après** affectation. Le défaut ne se manifestait
   que lorsque `Homey` était **déjà** prêt. ⇒ tester **les deux** chemins de démarrage.
9. **`Homey.emit()` en requête/réponse + polling**, jamais `session.emit()` en push : sinon un
   balayage échoué et des événements jamais arrivés sont indiscernables.

Plus : **un appel d'API d'app est coupé à 10 s** et un balayage /24 prend ~16 s ⇒ le balayage se
**lance** puis s'interroge (le cache de la lane H), avec une barre qui bouge — un écran figé de
seize secondes se lit comme cassé.

🔴 **Quand rien n'est trouvé, ne pas afficher « aucun appareil trouvé »** mais **ce qu'il faut aller
activer** (§3.1 bis) : SNMP dans DSM, ou SNMP sur la carte de l'onduleur — désactivé par défaut sur
les firmwares APC récents. Distinguer « joignable en ICMP mais muet en SNMP » du reste. **C'est le
symptôme exact qui laisse le fil APC du forum en échec depuis 2018**, et probablement le premier
différenciateur réel de l'app.

**Lot 8** : écrire le harnais qui **exécute le JavaScript de la vue dans un DOM minimal**, sous les
**deux** chemins de démarrage. C'est le seul filet qui attrape les pannes 2, 3, 7 et 8.

---

## Lane H — découverte, OUI et cache de balayage

1. `.homeycompose/discovery/ups.json` — stratégie **`mac`** :
   `{ "type": "mac", "mac": { "manufacturer": [[0,192,181]] } }` (préfixes OUI **en décimal**).
   Un onduleur n'annonce rien en mDNS ; la stratégie `mac` résout l'adresse par ARP et donne
   `onDiscoveryAddressChanged`, donc **la résilience DHCP sans dépendre d'aucune annonce**.
   Un driver ne référence **qu'une seule** stratégie.
2. `lib/snmp/oui.mts` — la liste des OUI, **sourcée** : APC/Schneider, Eaton, Synology, QNAP,
   CyberPower, Riello, Socomec, Vertiv. Un commentaire par entrée disant d'où elle vient.
3. **Le cache de balayage au niveau app** (`app.mts` + `api.mts`) : `POST /scan` démarre et rend la
   main **immédiatement**, `GET /scan` rapporte l'avancement. Un second démarrage pendant qu'un
   balayage tourne **retourne celui en vol**, il n'en lance pas un deuxième. Motif éprouvé dans
   `homey-netprinter/api.mts` — le lire.
4. `drivers/ups/driver.mts` — handlers `onPair` : `scan_start`, `scan_status`, `probe`, `adopted`,
   et un handler `viewLog` alimentant le tampon de traces. Plus `onRepair` pour corriger une adresse.
   L'appariement se fait sur l'**identité SNMP** (modèle, série), **jamais sur l'adresse**.

---

## Lane I — finitions

1. `README.md` — compléter : comment activer SNMP côté DSM **et** côté carte APC, ce que fait
   chaque carte de Flow, l'exemple de Flow qui justifie l'app (« passé sur batterie ⇒ couper le non
   essentiel, et sous 5 minutes d'autonomie, arrêter le NAS proprement »).
2. `locales/{en,fr,nl}.json` — les trois n'ont **qu'une clé racine** : compléter tous les libellés
   que le code référence par `homey.__()`.
3. `settings/index.html` — page de diagnostic : ce que le balayage voit, le tampon de traces,
   un bouton de test par adresse. Une page de settings **inclut** `/homey.js` et utilise
   `onHomeyReady` — contrairement à une vue de pairing.
4. `drivers/ups/driver.settings.compose.json` — 🔴 le réglage `community` doit être de
   **`type: "password"`** (saisie masquée), pas `text`. Il reste modifiable par l'utilisateur :
   indispensable pour dépanner, donc pas dans `store`.
5. Images du driver : 75×75, 500×500, 1000×1000. Guideline 1.4.3 : **l'appareil sur fond blanc**, et
   **ne pas réutiliser** l'image de l'app.

---

## Fini quand

`npm run typecheck`, `npm test` et `npx homey app validate --level publish` passent, et chaque lane
a commité ses seuls fichiers avec un message qui dit **pourquoi**.
