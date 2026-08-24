import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Un réglage montré à l'utilisateur doit avoir un effet.
 *
 * 🔴 Les trois drivers déclaraient un réglage « port SNMP » ; **seul l'onduleur s'en
 * servait**. Chez le NAS et le port de switch, `readSettings()` ne lisait pas la clé et
 * `buildClient()` ne la passait pas : un appareil appairé sur un port non standard
 * s'appairait correctement — le pairing passe par le client du *driver*, qui l'honore —
 * puis n'était plus jamais interrogé. Indisponible en permanence, sans rien dans les
 * journaux qui désigne le port.
 *
 * Rien ne pouvait le voir : le compilateur est content d'un champ non lu, `homey app
 * validate` ne lit que la forme du JSON, et le relevé de bout en bout tournait sur 161.
 *
 * Le garde-fou part du **réglage déclaré**, pas d'une liste de drivers écrite à la main :
 * un futur driver qui expose un port est couvert sans qu'on y pense.
 */

const DRIVERS = ['ups', 'nas', 'netswitch'] as const;

// `process.cwd()`, et non un chemin relatif au module : la suite compile les tests
// dans `.testbuild/`, d'où une URL relative désignerait un arbre qui ne contient ni les
// sources `.mts` ni les fichiers de composition. Même choix que `repair-views.test.mts`.
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

for (const driver of DRIVERS) {
  const settings = read(`drivers/${driver}/driver.settings.compose.json`);
  if (!/"id"\s*:\s*"port"/.test(settings)) continue;

  test(`🔴 ${driver} : le réglage de port déclaré est réellement utilisé`, () => {
    const device = read(`drivers/${driver}/device.mts`);

    // 🔴 Les quatre clés de connexion, pas seulement `port`.
    //
    // `port` a fait défaut parce que personne ne le lisait ; rien n'empêche `community`,
    // `host` ou `version` de subir le même sort. Un `getSetting('comunity')` mal
    // orthographié ne serait vu par rien : le compilateur voit deux `unknown` de part et
    // d'autre, `homey app validate` ne lit que la forme du JSON, et le `Device` de Homey
    // ne s'instancie dans aucun test. Ce garde statique est la seule chose qui reste.
    for (const cle of ['host', 'community', 'port', 'version']) {
      assert.match(
        device,
        new RegExp(`getSetting\\('${cle}'\\)`),
        `les réglages relus doivent lire la clé \`${cle}\``,
      );
    }

    // Chaque session ouverte doit recevoir le port. `new SnmpClient({…})` en lecture,
    // `writeVarbinds({…})` en écriture : une commande envoyée sur 161 alors que l'agent
    // écoute ailleurs part dans le vide, en silence.
    for (const call of device.match(/new SnmpClient\(\{[^}]*\}/g) ?? []) {
      assert.match(call, /\bport\b/, `un client SNMP construit sans port : ${call}`);
    }
    for (const call of device.match(/writeVarbinds\(\{[^}]*\}/g) ?? []) {
      assert.match(call, /\bport\b/, `une écriture SNMP sans port : ${call}`);
    }

    // Sans cela, changer le port dans les réglages ne reconstruit pas la conversation :
    // l'appareil continuerait de parler à l'ancien port jusqu'au prochain redémarrage.
    const keys = device.match(/const CONNECTION_KEYS = \[[^\]]*\]/)?.[0] ?? '';
    for (const cle of ['host', 'community', 'port', 'version']) {
      assert.match(keys, new RegExp(`'${cle}'`), `changer ${cle} doit invalider la conversation`);
    }
  });
}
