# Brief d'exécution — lots 0 à 2

App Homey **« SNMP - Network Devices »**, id `com.dataweavelabs.netdevices`.
TypeScript ESM (`.mts` → `.mjs`), SDK Homey v3.

**Plan complet** : `.omc/plans/autopilot-impl.md` — **à lire avant de coder**.
**Référence OID** : `.omc/plans/annexe-a-oid.md` — les OID exacts, avec leurs pièges.

Déjà en place : `package.json`, `tsconfig.json`, `tsconfig.test.json`, `node_modules`,
`lib/snmp/opaque.mts` + son test. `npm test` doit fonctionner dès maintenant.

---

## Règle absolue de non-collision

Trois lanes travaillent **dans le même dépôt en parallèle**. Chacune n'écrit **que** dans ses
fichiers. Toute écriture hors de son périmètre détruit le travail d'une autre.

| Lane | Lot | Écrit **uniquement** dans |
|---|---|---|
| **A** | 0 — socle SNMP | `lib/snmp/**` (sauf `opaque.mts`), `test/snmp/**` |
| **B** | 1 — squelette app | racine (`app.mts`, `api.mts`, `README.md`), `.homeycompose/**`, `settings/**`, `assets/**`, `locales/**` |
| **C** | 2 — lecture onduleur | `lib/ups/**`, `test/ups/**` |

- **Ne jamais** lancer `git stash`, `git reset`, `git checkout --`, `git checkout <branche>`, `git add -A`.
- Committer **par pathspec explicite**, uniquement ses propres fichiers.
- Ne pas modifier `package.json`, `tsconfig*.json` ni `lib/snmp/opaque.mts` — sauf lane B pour
  `package.json`, et seulement pour **ajouter** une dépendance manquante.

---

## Lane A — lot 0 : le socle SNMP partagé

Source à recopier : `/Users/byackee/Documents/GitHub/homey-netprinter/lib/` — **en lecture seule**,
ne rien y modifier. C'est une app publiée.

1. `lib/snmp/client.mts` ← copie de `snmp-client.mts`. Garder le comportement : une session par
   opération, `toValue()` rend le **Buffer brut** pour `Opaque` (le décodage appartient au lecteur,
   pas au transport — `lib/snmp/opaque.mts` s'en charge, ne pas le dupliquer).
2. `lib/snmp/scan.mts` ← copie de `network-scan.mts`, **avec la sonde en paramètre** au lieu de la
   question imprimante codée en dur :
   `scanSubnet<T>(subnet: string, probe: (client: SnmpClient) => Promise<T | null>, …): Promise<T[]>`
3. `lib/snmp/trace.mts` — tampon circulaire borné et horodaté. Il existe **dès le premier commit** :
   une app installée par CLI n'a aucun log lisible, et c'est ce tampon qui a localisé chaque panne
   des trois apps précédentes (plan §8.3).
4. Tests dans `test/snmp/` pour le scan paramétré et le tampon.

Ne pas réécrire ce qui marche : recopier d'abord, paramétrer ensuite.

---

## Lane B — lot 1 : le squelette de l'app

1. `.homeycompose/app.json` — id `com.dataweavelabs.netdevices`, nom **« SNMP - Network Devices »**
   (en/fr/nl), `sdk: 3`, **`compatibility: ">=12.0.1"`** (obligatoire pour une app ESM, sinon la
   validation échoue sans expliquer pourquoi), `platforms: ["local"]`, `category: ["energy"]`,
   `brandColor`, et des `tags` chargés de marques : `apc, eaton, riello, cyberpower, socomec,
   synology, qnap, onduleur, ups, nas, snmp`.
2. `app.json` **à la racine** — artefact généré par HomeyCompose, **mais le CLI le lit avant de
   générer** : il doit exister et être versionné pour amorcer.
3. `settings/index.html` — **non vide**, un dossier `settings/` vide fait échouer la validation.
   Une page de settings inclut bien `<script src="/homey.js">` et utilise `onHomeyReady` — contrairement
   à une vue de pairing, où c'est interdit.
4. `app.mts` et `api.mts` minimaux. `api.mts` expose `GET /trace` (tampon de la lane A) — **tout appel
   d'API d'app est coupé à 10 s**, donc rien de long en synchrone.
5. `assets/` — images app 250×175 / 500×350 / 1000×700.
6. `locales/en.json`, `fr.json`, `nl.json`.
7. `README.md` — dire franchement ce qui est supporté et ce qui ne l'est pas : QNAP non confirmé,
   Linux+NUT non supporté, SNMPv3 absent, et **sur le chemin NAS l'app voit le début d'une coupure,
   pas sa fin** (plan §3.8).

Vérifier par `npx homey app validate --level debug`.

---

## Lane C — lot 2 : lire l'onduleur relayé par un Synology

C'est **le chemin principal** de l'app, pas un cas secondaire. OID exacts en annexe A §6a.

1. `lib/ups/synology-mib.mts` — dictionnaire d'OID sous `1.3.6.1.4.1.6574.4`.
2. `lib/ups/nut-status.mts` — parseur de `upsInfoStatus`, qui est une **chaîne NUT**, pas un code.
   Les jetons **se combinent**, séparés par une espace : `"OL"`, `"OL CHRG"`, `"OB LB"`.
   13 jetons connus : `OL OB LB HB RB CHRG DISCHRG BYPASS CAL OFF OVER TRIM BOOST FSD`.
   Un jeton inconnu ne doit pas faire échouer la lecture.
3. `lib/ups/reader.mts` — construit un snapshot. Les mesures passent par `toNumber()` de
   `lib/snmp/opaque.mjs` (Synology encode en `Opaque Float`).
   🔴 **`upsBatteryRuntimeValue` est en SECONDES** (et c'est un `Integer32`, pas un Float) :
   normaliser en **minutes** ici même, jamais plus haut. Trois autres sources ont trois autres unités.
4. Tests dans `test/ups/` : **une fixture par source**, avec des valeurs qui rendent les conversions
   **discernables**. Si toutes les fixtures d'autonomie valent 60, alors ÷60, ÷6000 et « rien » donnent
   le même résultat et le test ne prouve rien (plan §8.5).
   Couvrir : `"OL CHRG"`, `"OB LB"`, un jeton inconnu, un OID absent (⇒ `null`, **jamais 0**).

🔴 **`null` reste `null` jusqu'à la capability.** Un cast qui écrase le `null` donnerait 0 % de batterie
au lieu d'« inconnu », et 0 % déclenche les alarmes de coupure. Fausse alerte en pleine nuit.

---

## Fini quand

`npm run typecheck` et `npm test` passent, et chaque lane a commité ses propres fichiers par pathspec
explicite avec un message qui dit **pourquoi**, pas seulement quoi.
