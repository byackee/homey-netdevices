import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Toute capability custom a une icône, et cette icône est faite de tracés **pleins**.
 *
 * 🔴 Une icône en contours seuls s'affiche dans l'app web et **disparaît sur mobile** :
 * le client mobile rastérise chaque icône en masque, et une forme sans remplissage n'a
 * rien à rastériser. Les vecteurs d'Athom eux-mêmes sont des tracés pleins, pour cette
 * raison exacte. Le défaut a été payé sur `homey-netprinter`, où toutes les icônes ont
 * dû être redessinées.
 *
 * `homey app validate` n'en dit rien : une icône absente ou invisible valide proprement.
 */

const root = process.cwd();
const CAPS = `${root}/.homeycompose/capabilities`;

const files = readdirSync(CAPS).filter((name) => name.endsWith('.json'));

test('il y a bien des capabilities custom à vérifier', () => {
  assert.ok(files.length > 0, 'aucune capability trouvée — le test ne prouverait rien');
});

test('🔴 chaque capability custom déclare une icône, et le fichier existe', () => {
  for (const file of files) {
    const cap = JSON.parse(readFileSync(`${CAPS}/${file}`, 'utf8')) as { icon?: string };
    assert.ok(cap.icon, `${file} n'a pas d'icône : Homey affichera un placeholder générique`);
    assert.ok(existsSync(`${root}${cap.icon}`), `${cap.icon} est déclaré mais absent du dépôt`);
  }
});

test('🔴 aucune icône n\'est en contours seuls : elles disparaîtraient sur mobile', () => {
  for (const file of files) {
    const cap = JSON.parse(readFileSync(`${CAPS}/${file}`, 'utf8')) as { icon?: string };
    if (!cap.icon) continue;
    const svg = readFileSync(`${root}${cap.icon}`, 'utf8');

    assert.ok(svg.includes('fill='), `${cap.icon} ne déclare aucun remplissage`);
    assert.ok(!/fill\s*=\s*["']none["']/.test(svg),
      `${cap.icon} porte fill="none" — invisible sur mobile`);
    assert.ok(!/\bstroke\s*=\s*["'](?!none)/.test(svg),
      `${cap.icon} dessine en contour ; l'app mobile ne rastérise que les surfaces`);
    assert.ok(/<path\b/.test(svg), `${cap.icon} ne contient aucun tracé`);
  }
});

test('les icônes portent un viewBox : sans lui, rien ne se met à l\'échelle', () => {
  for (const file of files) {
    const cap = JSON.parse(readFileSync(`${CAPS}/${file}`, 'utf8')) as { icon?: string };
    if (!cap.icon) continue;
    assert.ok(readFileSync(`${root}${cap.icon}`, 'utf8').includes('viewBox='), `${cap.icon} sans viewBox`);
  }
});
