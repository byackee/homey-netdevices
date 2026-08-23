/**
 * Transformer le résultat brut d'un `walk` en lignes de table.
 *
 * Un parcours SNMP rend une carte plate — `1.3.6.1.2.1.25.2.3.1.3.7` → `'/volume1'` —
 * et rien d'autre. Ce fichier est le seul endroit qui sait que le `3` est une colonne et
 * que le `7` est un index.
 *
 * Il vit à part du lecteur pour une raison précise : c'est du découpage de chaînes, donc
 * exactement le genre de code dont une erreur ne produit **aucun message**. Une colonne
 * mal identifiée ne lève pas, elle rend une table vide — et une table vide se lit comme
 * « cet hôte n'a pas de volume », ce qui est parfaitement crédible. Ici, ça se teste.
 *
 * 🔴 **Aucune ligne n'est présumée.** Ni le nombre, ni les index, ni leur continuité.
 * Sous Linux, `hrStorageIndex` suit l'ordre de montage et vaut couramment `1, 3, 6, 7,
 * 31, 35` : boucler de 1 à N manquerait la moitié des volumes sans qu'aucune erreur ne
 * remonte. C'est la même raison qui a fait choisir `walk` plutôt que `get` dans le
 * contrat `NasSnmpSource`.
 */

import type { SnmpValue } from './snapshot.mjs';

/** Une ligne : sa clé d'index, et ses colonnes lues. */
export interface TableRow {
  index: number;
  cells: Map<number, SnmpValue>;
}

/**
 * Découpe un parcours en lignes, à partir de la racine de l'entrée de table.
 *
 * `root` est l'OID de l'*entry* — `1.3.6.1.2.1.25.2.3.1` pour `hrStorageEntry` — sous
 * lequel chaque feuille se lit `<root>.<colonne>.<index>`.
 *
 * Ce qui est écarté, et pourquoi :
 * - **un OID hors de `root`** : `subtree()` ne devrait pas en rendre, mais un agent qui
 *   déborde de son sous-arbre existe, et l'interpréter comme une ligne inventerait des
 *   volumes ;
 * - **un suffixe qui n'a pas exactement deux composants numériques** : les tables lues
 *   ici (`hrStorageTable`, `entPhySensorTable`) s'indexent toutes sur un entier unique.
 *   Un index composite — celui de PoE, `{groupe, port}`, en est un — ne se replie pas
 *   sur un entier, et le forcer donnerait des lignes fusionnées les unes dans les autres.
 *
 * Les lignes ressortent **triées par index**, pour que deux relevés du même hôte
 * produisent la même liste dans le même ordre : sans ça, l'ordre d'affichage des volumes
 * changerait au gré de ce que l'agent renvoie en premier.
 */
export function tableRows(values: ReadonlyMap<string, SnmpValue>, root: string): TableRow[] {
  const prefix = `${root.replace(/^\./, '')}.`;
  const rows = new Map<number, TableRow>();

  for (const [rawOid, value] of values) {
    const oid = rawOid.replace(/^\./, '');
    if (!oid.startsWith(prefix)) continue;

    const parts = oid.slice(prefix.length).split('.');
    if (parts.length !== 2) continue;

    const column = Number(parts[0]);
    const index = Number(parts[1]);
    if (!Number.isInteger(column) || !Number.isInteger(index)) continue;

    let row = rows.get(index);
    if (row === undefined) {
      row = { index, cells: new Map() };
      rows.set(index, row);
    }
    row.cells.set(column, value);
  }

  return [...rows.values()].sort((a, b) => a.index - b.index);
}

/**
 * Le numéro de colonne d'un OID de colonne.
 *
 * `hrStorageDescr` vaut `1.3.6.1.2.1.25.2.3.1.3` : sa colonne est `3`. Dérivé plutôt que
 * recopié, pour qu'il n'existe **qu'une** définition de chaque colonne. Deux constantes
 * — un OID d'un côté, un numéro de l'autre — divergeraient un jour, et la divergence se
 * lirait comme une table vide, jamais comme une erreur.
 */
export function columnId(columnOid: string): number {
  const last = columnOid.split('.').pop() ?? '';
  const id = Number(last);
  if (!Number.isInteger(id)) throw new Error(`colonne illisible : ${columnOid}`);
  return id;
}

/**
 * Découpe le parcours d'une **colonne seule** en couples index/valeur.
 *
 * `hrProcessorLoad` se lit ainsi : on ne veut qu'une colonne, et la parcourir seule
 * coûte un aller-retour au lieu de traverser tout `hrDeviceTable`, qui porte aussi les
 * disques, les imprimantes et les cartes réseau de la machine.
 *
 * Même discipline que {@link tableRows} : un suffixe qui n'est pas un entier unique est
 * écarté, et le résultat est trié par index.
 */
export function columnRows(
  values: ReadonlyMap<string, SnmpValue>,
  column: string,
): { index: number; value: SnmpValue }[] {
  const prefix = `${column.replace(/^\./, '')}.`;
  const out: { index: number; value: SnmpValue }[] = [];

  for (const [rawOid, value] of values) {
    const oid = rawOid.replace(/^\./, '');
    if (!oid.startsWith(prefix)) continue;

    const suffix = oid.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;

    out.push({ index: Number(suffix), value });
  }

  return out.sort((a, b) => a.index - b.index);
}
