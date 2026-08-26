import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 🔴 Ce que l'app **émet** est en anglais. Ce qu'elle **commente** reste en français.
 *
 * Signalé sans le vouloir par un utilisateur néerlandophone (Jeroen6, forum Homey) : son
 * balayage n'affichait rien, il est allé lire les journaux, et il y a trouvé « un
 * onduleur ». Il a rapporté la phrase telle quelle, faute de pouvoir la lire.
 *
 * Le journal d'une app Homey n'est pas une note interne : c'est la seule surface de
 * diagnostic qu'un utilisateur puisse consulter, celle qu'il recopie dans un rapport de
 * bug, celle qu'un relecteur du store ouvre. Les messages d'erreur comptent double : ils
 * remontent jusqu'au bandeau d'indisponibilité de l'appareil et jusqu'aux vues de pairing.
 *
 * ═══ Deux versions de ce garde se sont fait prendre en défaut, et il faut le dire ═══
 *
 * 1. Détecter le français **par ses accents** laissait passer `` `${host} est un onduleur` ``,
 *    qui n'en porte aucun — c'est-à-dire exactement la ligne que l'utilisateur avait
 *    rapportée. D'où la liste de mots.
 * 2. Chercher le français **ligne par ligne, près d'un appel** laissait passer un
 *    `super(…)` dont la chaîne vit sur la ligne suivante. C'est le cas de
 *    `SnmpUnreachableError`, dont le message est le plus visible de toute l'app.
 *
 * Cette version-ci ne raisonne donc plus par lignes ni par appels : elle extrait les
 * **littéraux de chaîne** du code, commentaires retirés, et les juge un par un. Un
 * littéral peut s'étendre sur autant de lignes qu'il veut.
 *
 * Les traductions volontaires sont épargnées : `this.homey.__({ en, fr, nl })` porte du
 * français par construction, et c'est très bien. Seules les valeurs des clés `fr:` et
 * `nl:` bénéficient de cette exemption.
 */

const RACINE = process.cwd();
const SOURCES = ['lib', 'drivers'];
const FICHIERS_RACINE = ['app.mts', 'api.mts'];

const ACCENT = /[éèêëàâäçùûüôöîïÉÈÊÀÂÇÔÎ]/;

/**
 * Des mots qui n'existent qu'en français, ou n'y ont pas le même sens qu'en anglais.
 *
 * On évite les faux amis — `impossible`, `port`, `note`, `message`, `distance`, `table`
 * s'écrivent pareil dans les deux langues et feraient échouer des chaînes parfaitement
 * anglaises.
 */
const MOTS_FRANCAIS = new RegExp(
  '\\b('
  + [
    'onduleur', 'onduleurs', 'balayage', 'releve', 'appareil', 'appareils',
    'muet', 'muette', 'aucun', 'aucune', 'inconnu', 'inconnue', 'sonde',
    'ecriture', 'reglages', 'injoignable', 'illisible', 'annoncee', 'annoncees',
    'communaute', 'hote', 'cesse', 'trouve', 'termine', 'decouverte', 'colonne',
    'refuse', 'reponse',
    // Mots grammaticaux : ils ne peuvent pas apparaître dans une phrase anglaise.
    'est', 'sur', 'pour', 'avec', 'sans', 'dans', 'les', 'des', 'une', 'sous',
    'pendant', 'depuis', 'mais', 'donc', 'chaque', 'toutes', 'cet', 'cette',
  ].join('|')
  + ')\\b',
  'i',
);

function sansAccents(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function estFrancais(texte: string): boolean {
  return ACCENT.test(texte) || MOTS_FRANCAIS.test(sansAccents(texte));
}

/** Retire les commentaires — c'est là que vit le français légitime. */
function sansCommentaires(source: string): string {
  let sortie = '';
  let i = 0;
  while (i < source.length) {
    const deux = source.slice(i, i + 2);
    if (deux === '//') {
      const fin = source.indexOf('\n', i);
      i = fin < 0 ? source.length : fin;
      continue;
    }
    if (deux === '/*') {
      const fin = source.indexOf('*/', i + 2);
      i = fin < 0 ? source.length : fin + 2;
      continue;
    }
    // Une chaîne est recopiée telle quelle : un `//` à l'intérieur n'ouvre pas un commentaire.
    if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const guillemet = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== guillemet) {
        j += source[j] === '\\' ? 2 : 1;
      }
      sortie += source.slice(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }
    sortie += source[i];
    i += 1;
  }
  return sortie;
}

interface Litteral { texte: string; avant: string }

/** Tous les littéraux de chaîne du code, avec le peu de contexte qui les précède. */
function litteraux(code: string): Litteral[] {
  const sortie: Litteral[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        j += code[j] === '\\' ? 2 : 1;
      }
      sortie.push({
        texte: code.slice(i + 1, j),
        avant: code.slice(Math.max(0, i - 8), i),
      });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return sortie;
}

/** `fr:` et `nl:` portent du français à dessein — ce sont les traductions de l'app. */
function estUneTraduction(avant: string): boolean {
  return /\b(fr|nl)\s*:\s*$/.test(avant);
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

test('🔴 aucune chaîne émise n’est en français', () => {
  const chemins = [
    ...SOURCES.flatMap((dossier) => fichiers(join(RACINE, dossier))),
    ...FICHIERS_RACINE.map((nom) => join(RACINE, nom)),
  ];

  const fautives: string[] = [];
  let examines = 0;

  for (const chemin of chemins) {
    const code = sansCommentaires(readFileSync(chemin, 'utf8'));
    for (const { texte, avant } of litteraux(code)) {
      if (texte.trim() === '') continue;
      examines += 1;
      if (estUneTraduction(avant)) continue;
      if (estFrancais(texte)) {
        fautives.push(`${chemin.slice(RACINE.length + 1)} — ${texte.slice(0, 90)}`);
      }
    }
  }

  assert.ok(examines > 200, `seulement ${examines} littéraux examinés — ce garde ne prouverait plus rien`);
  assert.deepEqual(
    fautives,
    [],
    'chaîne française émise : le journal et les messages d’erreur sont ce que l’utilisateur lit\n'
    + fautives.join('\n'),
  );
});
