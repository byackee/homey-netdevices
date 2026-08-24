import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Chaque vue déclarée doit exister dans le dossier que Homey lit réellement.
 *
 * 🔴 `homey app validate` ne vérifie **que** `drivers[].pair[]` : `repair` est absent du
 * schéma du manifeste. Une vue de réparation rangée au mauvais endroit valide donc
 * proprement au niveau publication, et ne casse qu'au moment où l'utilisateur appuie sur
 * Maintenance — c'est-à-dire précisément quand il en a besoin, son appareil ayant changé
 * d'adresse. Confirmé sur un vrai Homey pour `homey-netprinter` :
 * `unknown_error_getting_file` tant que le fichier était sous `pair/`.
 *
 * Ce test dit ce que le validateur ne dira jamais.
 */

// Résolu depuis la racine du dépôt et non depuis ce fichier : les tests s'exécutent
// compilés sous `.testbuild/`, où `../app.json` ne mène nulle part.
const root = process.cwd();
const app = JSON.parse(readFileSync(`${root}/app.json`, 'utf8')) as {
  drivers?: { id: string; pair?: { id?: string }[]; repair?: { id?: string }[] }[];
};

const exists = (path: string) => existsSync(`${root}/${path}`);

test('🔴 toute vue de réparation déclarée a son fichier sous repair/', () => {
  for (const driver of app.drivers ?? []) {
    for (const view of driver.repair ?? []) {
      if (!view.id) continue;
      assert.ok(
        exists(`drivers/${driver.id}/repair/${view.id}.html`),
        `drivers/${driver.id}/repair/${view.id}.html manque — Homey rendra « error getting file »`,
      );
    }
  }
});

test('toute vue de pairing déclarée a son fichier sous pair/', () => {
  for (const driver of app.drivers ?? []) {
    for (const view of driver.pair ?? []) {
      if (!view.id) continue;
      assert.ok(
        exists(`drivers/${driver.id}/pair/${view.id}.html`),
        `drivers/${driver.id}/pair/${view.id}.html manque`,
      );
    }
  }
});

test('aucune copie orpheline ne traîne dans pair/ pour une vue que seul repair déclare', () => {
  // La copie morte n'est pas inerte : elle se met à diverger de celle que Homey lit,
  // et le prochain correctif atterrit dans le mauvais fichier.
  for (const driver of app.drivers ?? []) {
    const paired = new Set((driver.pair ?? []).map((v) => v.id));
    for (const view of driver.repair ?? []) {
      if (!view.id || paired.has(view.id)) continue;
      assert.ok(
        !exists(`drivers/${driver.id}/pair/${view.id}.html`),
        `drivers/${driver.id}/pair/${view.id}.html est une copie morte`,
      );
    }
  }
});

/**
 * 🔴 La community stockée ne se réaffiche pas en clair.
 *
 * Le réglage est de type `password` : Homey le masque partout. Mais la vue de réparation
 * reçoit la valeur **stockée** et la peignait dans un champ texte — ouvrir « réparer »
 * suffisait donc à relire un secret que l'app masque ailleurs, ce qui vidait ce masquage
 * de son sens.
 *
 * La vue d'appairage, elle, garde son champ lisible, et c'est délibéré : l'utilisateur y
 * **tape** la community et doit pouvoir vérifier ce qu'il a saisi. Les deux situations ne
 * posent pas le même problème — l'une affiche ce qu'on lui a donné, l'autre révèle ce
 * qu'elle avait gardé.
 *
 * ⚠️ Ce que ce garde ne couvre pas : la valeur atteint toujours la vue, donc reste
 * lisible à qui ouvre les outils de développement. La corriger vraiment demanderait de ne
 * plus l'envoyer et de traiter un champ vide comme « inchangé ».
 */
test('🔴 les vues de réparation masquent la community, les vues d’appairage non', () => {
  const racine = process.cwd();
  const drivers = readdirSync(join(racine, 'drivers'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let vues = 0;
  for (const driver of drivers) {
    for (const [sous, fichier, attendu] of [
      ['repair', 'repair.html', 'password'],
      ['pair', 'start.html', 'text'],
    ] as const) {
      const chemin = join(racine, 'drivers', driver, sous, fichier);
      if (!existsSync(chemin)) continue;
      const html = readFileSync(chemin, 'utf8');

      const champ = html.match(/<input[^>]*id="[a-z-]*community"[^>]*>/)?.[0];
      if (!champ) continue;
      vues += 1;

      assert.match(champ, new RegExp(`type="${attendu}"`), `${driver}/${sous} : ${champ}`);
      // Le navigateur ne doit mémoriser aucune des deux.
      assert.match(champ, /autocomplete="off"/, `${driver}/${sous} sans autocomplete="off"`);
    }
  }
  assert.ok(vues >= 5, `seulement ${vues} champ(s) vus — le test ne prouverait rien`);
});
