import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Ce que la relecture du store refuse, et que `homey app validate` ne voit jamais.
 *
 * 🔴 Athom livre sa grille de relecture dans le SDK —
 * `node_modules/homey-lib/lib/AIReviewer/data/{checklist,guidelines}.md` — mais le CLI ne
 * l'exécute pas. Une app peut donc valider `--level publish` sans une erreur et se faire
 * rejeter à la certification. C'est arrivé : la v1.0.6 est partie en relecture avec
 * l'icône du driver onduleur comme icône d'app.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const md5 = (p: string) => createHash('md5').update(readFileSync(join(root, p))).digest('hex');

const DRIVERS = readdirSync(join(root, 'drivers'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test('🔴 l’icône de l’app n’est celle d’aucun driver', () => {
  // checklist.md : « App icon cannot be the same as a driver icon — reject. »
  const app = md5('assets/icon.svg');
  for (const d of DRIVERS) {
    const p = `drivers/${d}/assets/icon.svg`;
    if (!existsSync(join(root, p))) continue;
    assert.notEqual(md5(p), app, `assets/icon.svg est identique à ${p}`);
  }
});

test('🔴 les icônes des drivers sont distinctes entre elles', () => {
  const vues = new Map<string, string>();
  for (const d of DRIVERS) {
    const p = `drivers/${d}/assets/icon.svg`;
    if (!existsSync(join(root, p))) continue;
    const h = md5(p);
    const deja = vues.get(h);
    assert.equal(deja, undefined, `${p} est identique à ${deja}`);
    vues.set(h, p);
  }
});

test('🔴 le README reste court et n’énumère pas les fonctionnalités', () => {
  // guidelines.md : « one to two paragraphs maximum » et « Do not list all the different
  // features, capabilities, and Flow cards available ».
  for (const f of ['README.txt', 'README.fr.txt', 'README.nl.txt']) {
    const texte = read(f).trim();
    const paragraphes = texte.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    assert.ok(paragraphes.length <= 2, `${f} : ${paragraphes.length} paragraphes`);

    // Une section en capitales est le signe d'un README qui redevient une brochure.
    const sections = texte.split('\n').filter((l) => /^[A-Z][A-Z ]{4,}$/.test(l.trim()));
    assert.deepEqual(sections, [], `${f} porte des sections : ${sections.join(', ')}`);
  }
});

test('🔴 le README est traduit partout où la description l’est', () => {
  // homey/lib/App.js attend `README.<code>.txt`. guidelines.md : « if the description is
  // translated to a language, the readme should also be translated ».
  const compose = JSON.parse(read('.homeycompose/app.json'));
  for (const langue of Object.keys(compose.description ?? {})) {
    const f = langue === 'en' ? 'README.txt' : `README.${langue}.txt`;
    assert.ok(existsSync(join(root, f)), `${f} manque alors que description.${langue} existe`);
  }
});

/**
 * 🔴 Une liste déroulante de **carte de Flow** veut `title` ; seuls les **réglages**
 * veulent `label`. Le schéma d'Athom n'a d'`additionalProperties: false` nulle part, si
 * bien qu'un `label` sur une carte est avalé en silence : la liste s'affiche alors avec
 * des identifiants bruts (`lowerLayerDown`), y compris sur la carte qui coupe un port.
 * Trois listes du driver switch étaient dans ce cas.
 */
test('🔴 les listes déroulantes des cartes de Flow portent title, jamais label', () => {
  const app = JSON.parse(read('app.json'));
  const cartes = [
    ...(app.flow?.triggers ?? []),
    ...(app.flow?.conditions ?? []),
    ...(app.flow?.actions ?? []),
  ];
  assert.ok(cartes.length > 0, 'aucune carte lue — le test ne prouverait rien');

  for (const carte of cartes) {
    for (const arg of carte.args ?? []) {
      if (arg.type !== 'dropdown') continue;
      assert.ok(arg.title, `${carte.id}/${arg.name} : argument sans title`);
      for (const v of arg.values ?? []) {
        assert.ok(v.title, `${carte.id}/${arg.name} valeur « ${v.id} » : title manquant`);
        assert.equal(v.label, undefined, `${carte.id}/${arg.name} valeur « ${v.id} » : label est ignoré ici`);
      }
    }
  }
});

test('🔴 toute clé de traduction appelée par une vue existe dans les trois langues', () => {
  // Le helper `t()` des vues retombe sur son littéral anglais quand la clé manque, si
  // bien qu'une absence ne casse rien et ne se voit pas : un utilisateur fr ou nl lit
  // simplement de l'anglais au milieu d'une vue traduite.
  const langues = ['en', 'fr', 'nl'] as const;
  const locales = Object.fromEntries(
    langues.map((l) => [l, JSON.parse(read(`locales/${l}.json`))]),
  );

  const porte = (d: unknown, chemin: string): boolean => {
    let cur: unknown = d;
    for (const part of chemin.split('.')) {
      if (typeof cur !== 'object' || cur === null || !(part in cur)) return false;
      cur = (cur as Record<string, unknown>)[part];
    }
    return true;
  };

  const vues: string[] = [];
  for (const d of DRIVERS) {
    for (const sous of ['pair', 'repair']) {
      const dir = join(root, 'drivers', d, sous);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
        vues.push(join('drivers', d, sous, f));
      }
    }
  }
  assert.ok(vues.length > 0, 'aucune vue trouvée — le test ne prouverait rien');

  for (const vue of vues) {
    // Un point dans la clé : c'est ce qui distingue `pair.probing` d'un `emit('adopted')`,
    // que le motif attraperait sinon par le `t` final de « emit ».
    const appels = [...read(vue).matchAll(/t\('([a-z0-9_]+\.[a-z0-9_.]+)'/g)].map((m) => m[1]!);
    for (const cle of new Set(appels)) {
      for (const l of langues) {
        assert.ok(porte(locales[l], cle), `${vue} appelle « ${cle} », absente de ${l}.json`);
      }
    }
  }
});
