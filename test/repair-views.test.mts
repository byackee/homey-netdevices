import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
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
