# Brief de revue — app Homey « SNMP - Network Devices »

**Tu es en LECTURE SEULE. Ne modifie aucun fichier source, aucun test, aucune configuration.**
Ton seul droit d'écriture est ton propre rapport, dans `.omc/reviews/<ton-angle>.md`.
Ne commite rien d'autre que ce fichier.

## Le code

`/Users/byackee/Documents/GitHub/homey-netdevices` — app Homey SDK v3, TypeScript ESM (`.mts`).
5 000 lignes de code, 3 600 de tests, 229 tests qui passent, `homey app validate --level publish`
qui passe. Rien n'a jamais tourné sur un vrai Homey ni contre un vrai onduleur.

- `lib/snmp/` — transport SNMP, balayage de sous-réseau, tampon de traces, décodeur `Opaque Float`
- `lib/ups/` — quatre sources (Synology, RFC 1628, APC), parseur de jetons NUT, mapping capabilities
- `drivers/ups/` — device à deux rythmes de poll, moteur de poll, vue de pairing, réparation
- `app.mts` / `api.mts` — cache de balayage partagé, endpoint de traces
- `tools/synology-ups-sim.mjs` — simulateur SNMP, exclu du paquet publié

## Le contexte qui compte

`.omc/plans/autopilot-impl.md` — le plan. **Lis au minimum §3.8, §8, et §3.2.**
`.omc/plans/annexe-a-oid.md` — les OID de référence, vérifiés aux RFC et aux MIB officielles.

Trois apps Homey précédentes (`homey-netprinter`, `homey-scrypted`, `homey-vtherm`) ont produit un
rétro de neuf pannes de pairing, toutes **muettes** et toutes **invisibles à `npm test` comme à
`homey app validate`**. Le §8 du plan les liste. Elles sont la principale source de risque.

## Ce que j'attends

Un rapport en markdown dans `.omc/reviews/<ton-angle>.md`, **par ordre de gravité décroissante**.
Pour chaque constat : **le problème / pourquoi il compte / le correctif précis** (fichier, ligne).

Distingue explicitement ce que tu as **vérifié en exécutant** (un test, une commande, une lecture de
valeur) de ce que tu **déduis à la lecture**. Un constat vérifié vaut dix hypothèses.

Ne consacre aucune place à la louange. Si une partie est solide, une ligne suffit et tu passes.
Si tu ne trouves rien de grave sur ton angle, dis-le franchement plutôt que de meubler — un rapport
honnête et court vaut mieux qu'une liste gonflée.

Tu peux exécuter `npm test`, `npx tsc --noEmit`, `node`, et lancer le simulateur
(`node tools/synology-ups-sim.mjs --port <port libre>`) pour vérifier tes hypothèses.
**Choisis un port différent de 1161 pour ne pas entrer en conflit avec les autres relecteurs.**
