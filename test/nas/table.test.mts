import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { HR_STORAGE_COLUMN, HR_STORAGE_TABLE } from '../../lib/nas/host-mib.mjs';
import { columnId, columnRows, tableRows } from '../../lib/nas/table.mjs';
import type { SnmpValue } from '../../lib/nas/snapshot.mjs';

/** Ce qu'un `walk` rend : une carte plate d'OID complets vers des valeurs. */
function walked(entries: Record<string, SnmpValue>): Map<string, SnmpValue> {
  return new Map(Object.entries(entries));
}

const T = HR_STORAGE_TABLE;

test('🔴 tableRows n\'a pas d\'index à trouver : il les découvre', () => {
  // Sous Linux, `hrStorageIndex` suit l'ordre de montage et vaut couramment 1, 3, 6, 31.
  // Boucler de 1 à N manquerait la moitié des volumes sans qu'aucune erreur ne remonte —
  // c'est le défaut que ce fichier existe pour rendre impossible.
  const rows = tableRows(walked({
    [`${T}.3.1`]: '/',
    [`${T}.3.3`]: '/volume1',
    [`${T}.3.6`]: '/volume2',
    [`${T}.3.31`]: '/dev/shm',
  }), T);

  assert.deepEqual(rows.map((row) => row.index), [1, 3, 6, 31]);
  assert.equal(rows[3]?.cells.get(3), '/dev/shm');
});

test('tableRows rassemble les colonnes d\'une même ligne', () => {
  const rows = tableRows(walked({
    [`${T}.1.7`]: 7,
    [`${T}.2.7`]: '1.3.6.1.2.1.25.2.1.4',
    [`${T}.3.7`]: '/volume1',
    [`${T}.4.7`]: 4096,
    [`${T}.5.7`]: 1_000_000,
    [`${T}.6.7`]: 715_000,
  }), T);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.index, 7);
  assert.equal(rows[0]?.cells.size, 6);
  assert.equal(rows[0]?.cells.get(columnId(HR_STORAGE_COLUMN.descr)), '/volume1');
  assert.equal(rows[0]?.cells.get(columnId(HR_STORAGE_COLUMN.allocationUnits)), 4096);
});

test('tableRows rend les lignes triées, pour que deux relevés donnent le même ordre', () => {
  // Sans ce tri, l'ordre d'affichage des volumes changerait au gré de ce que l'agent
  // renvoie en premier — donc les sous-capabilities apparaîtraient dans le désordre.
  const rows = tableRows(walked({
    [`${T}.3.31`]: '/c',
    [`${T}.3.3`]: '/a',
    [`${T}.3.12`]: '/b',
  }), T);
  assert.deepEqual(rows.map((row) => row.cells.get(3)), ['/a', '/b', '/c']);
});

test('tableRows tolère le point initial des deux côtés', () => {
  const rows = tableRows(walked({ [`.${T}.3.1`]: '/' }), `.${T}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.cells.get(3), '/');
});

test('🔴 tableRows écarte ce qui déborde du sous-arbre, au lieu d\'inventer une ligne', () => {
  const rows = tableRows(walked({
    [`${T}.3.1`]: '/volume1',
    '1.3.6.1.2.1.1.5.0': 'DiskStation',
    '1.3.6.1.2.1.25.3.3.1.2.1': 12,
  }), T);
  assert.equal(rows.length, 1, 'un OID étranger est devenu un volume');
});

test('🔴 tableRows refuse un index composite au lieu de le replier sur un entier', () => {
  // L'index PoE est `{groupe, port}` ; le forcer sur un entier fusionnerait des lignes
  // les unes dans les autres. Les tables lues ici s'indexent toutes sur un entier unique,
  // et ce qui n'y ressemble pas est écarté plutôt que deviné.
  const rows = tableRows(walked({
    [`${T}.3.1.2`]: 'composite',
    [`${T}.3.4`]: '/volume1',
  }), T);
  assert.deepEqual(rows.map((row) => row.index), [4]);
});

test('tableRows rend une liste vide sur un parcours vide', () => {
  assert.deepEqual(tableRows(walked({}), T), []);
});

// ---------------------------------------------------------------------------

test('columnRows découpe le parcours d\'une colonne seule', () => {
  const column = '1.3.6.1.2.1.25.3.3.1.2';
  const rows = columnRows(walked({
    [`${column}.1`]: 7,
    [`${column}.2`]: 91,
    [`${column}.3`]: 4,
    [`${column}.4`]: 12,
  }), column);

  assert.deepEqual(rows.map((row) => row.value), [7, 91, 4, 12]);
  assert.deepEqual(rows.map((row) => row.index), [1, 2, 3, 4]);
});

test('columnRows écarte un suffixe qui n\'est pas un entier unique', () => {
  const column = '1.3.6.1.2.1.25.3.3.1.2';
  const rows = columnRows(walked({
    [`${column}.1`]: 7,
    [`${column}.1.5`]: 99,
    [`${column}.x`]: 99,
  }), column);
  assert.deepEqual(rows.map((row) => row.index), [1]);
});

// ---------------------------------------------------------------------------

test('🔴 columnId dérive le numéro de colonne de l\'OID, il ne le recopie pas', () => {
  // Deux constantes — un OID d'un côté, un numéro de l'autre — divergeraient un jour, et
  // la divergence se lirait comme une table vide, jamais comme une erreur.
  assert.equal(columnId(HR_STORAGE_COLUMN.index), 1);
  assert.equal(columnId(HR_STORAGE_COLUMN.type), 2);
  assert.equal(columnId(HR_STORAGE_COLUMN.descr), 3);
  assert.equal(columnId(HR_STORAGE_COLUMN.allocationUnits), 4);
  assert.equal(columnId(HR_STORAGE_COLUMN.size), 5);
  assert.equal(columnId(HR_STORAGE_COLUMN.used), 6);
});

test('columnId lève sur un OID qui n\'en est pas un, plutôt que de rendre NaN', () => {
  assert.throws(() => columnId('pas.un.oid'), /unreadable column/);
});
