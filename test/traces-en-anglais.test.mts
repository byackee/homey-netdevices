import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 🔴 Ce que l'app **émet** est en anglais. Ce qu'elle **commente** reste en français.
 *
 * Signalé sans le vouloir par un utilisateur néerlandophone (Jeroen6, forum Homey) : son
 * balayage n'affichait rien, et il est allé lire les journaux, où il a trouvé « un
 * onduleur ». Il a compris — mais il a dû deviner, et il a rapporté la phrase telle
 * quelle faute de pouvoir la lire.
 *
 * Le journal d'une app Homey n'est pas une note interne : c'est la seule surface de
 * diagnostic qu'un utilisateur puisse consulter, celle qu'il recopie dans un rapport de
 * bug, et celle qu'un relecteur du store ouvre quand il veut comprendre un refus. Une app
 * dont l'interface parle trois langues ne peut pas n'avoir qu'un journal francophone.
 *
 * La règle s'arrête là où le lecteur change : les commentaires de code sont écrits pour
 * qui maintient l'app, et restent en français. Ce garde ne regarde donc que les appels
 * qui produisent une sortie — `this.log`, `this.error`, `this.note`, `trace.*` — et
 * ignore tout le reste du fichier.
 */

const RACINE = process.cwd();
const SOURCES = ['lib', 'drivers'];
const FICHIERS_RACINE = ['app.mts', 'api.mts'];

/** `this.log(…)`, `this.error(…)`, `this.note(…)`, `trace.warn(…)` — ce qui sort de l'app. */
const APPEL = /(?:this\.(?:log|error|note)|trace\.(?:debug|info|warn|error))\(/;

/**
 * Deux marqueurs, parce qu'un seul ne suffit pas.
 *
 * 🔴 Les accents d'abord — mais ils laissent passer le français qui n'en porte pas. La
 * première version de ce garde ne voyait rien à `` `${host} est un onduleur` ``, qui est
 * précisément la ligne que l'utilisateur a rapportée. La mutation l'a montré : réintroduire
 * cette phrase exacte laissait le test au vert.
 *
 * D'où la seconde liste : des mots qui n'existent qu'en français, ou qui n'ont pas le
 * même sens en anglais. On évite volontairement les faux amis — `impossible`, `port`,
 * `note`, `message`, `distance` s'écrivent pareil dans les deux langues et feraient
 * échouer des traces parfaitement anglaises.
 */
const ACCENT = /[éèêëàâäçùûüôöîïÉÈÊÀÂÇÔÎ]/;

const MOTS_FRANCAIS = new RegExp(
  '\\b('
  + [
    'onduleur', 'onduleurs', 'balayage', 'releve', 'appareil', 'appareils',
    'muet', 'muette', 'aucun', 'aucune', 'inconnu', 'inconnue', 'sonde',
    'ecriture', 'reglages', 'injoignable', 'illisible', 'annoncee', 'annoncees',
    'communaute', 'hote', 'cesse', 'trouve', 'termine', 'decouverte',
    // Mots grammaticaux : ils ne peuvent pas apparaitre dans une phrase anglaise.
    'est', 'sur', 'pour', 'avec', 'sans', 'dans', 'les', 'des', 'une', 'sous',
    'pendant', 'depuis', 'plus', 'mais', 'donc', 'chaque', 'toutes',
  ].join('|')
  + ')\\b',
  'i',
);

/** Le francais accentue se detecte tel quel ; le reste se compare sans accents. */
function sansAccents(texte: string): string {
  return texte.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function fichiers(racine: string): string[] {
  const sortie: string[] = [];
  for (const entree of readdirSync(racine, { withFileTypes: true })) {
    const chemin = join(racine, entree.name);
    if (entree.isDirectory()) sortie.push(...fichiers(chemin));
    else if (entree.name.endsWith('.mts')) sortie.push(chemin);
  }
  return sortie;
}

test('🔴 aucune trace émise n’est en français', () => {
  const chemins = [
    ...SOURCES.flatMap((dossier) => fichiers(join(RACINE, dossier))),
    ...FICHIERS_RACINE.map((nom) => join(RACINE, nom)),
  ];

  const fautives: string[] = [];
  let appels = 0;

  for (const chemin of chemins) {
    for (const [index, ligne] of readFileSync(chemin, 'utf8').split('\n').entries()) {
      if (!APPEL.test(ligne)) continue;
      appels += 1;
      // Un commentaire de fin de ligne est écrit pour le mainteneur, pas pour le journal.
      const emis = ligne.split('//')[0] ?? '';
      if (ACCENT.test(emis) || MOTS_FRANCAIS.test(sansAccents(emis))) {
        fautives.push(`${chemin.slice(RACINE.length + 1)}:${index + 1} — ${emis.trim().slice(0, 100)}`);
      }
    }
  }

  assert.ok(appels > 50, `seulement ${appels} appels de journal trouvés — ce garde ne prouverait plus rien`);
  assert.deepEqual(
    fautives,
    [],
    'trace émise en français : le journal est la seule surface de diagnostic de l’utilisateur\n'
    + fautives.join('\n'),
  );
});
