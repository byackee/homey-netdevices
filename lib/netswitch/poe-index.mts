/**
 * Relier une prise PoE `{groupe, port}` à un `ifIndex`.
 *
 * 🔴 **RFC 3621 ne définit aucun lien entre les deux.** `pethPsePortTable` s'indexe par
 * `{pethPsePortGroupIndex, pethPsePortIndex}` ; `ifTable` s'indexe par `ifIndex` ; aucun
 * objet standard ne dit lequel correspond à lequel. Chaque constructeur a tranché dans
 * son coin : certains font `pethPsePortIndex == ifIndex`, d'autres numérotent les prises
 * PoE à partir de 1 dans chaque groupe indépendamment de l'ordre des interfaces.
 *
 * Le brief est explicite : **si la correspondance échoue, ne pas inventer.** Une prise
 * mal reliée, c'est un `onoff` qui coupe l'alimentation d'une caméra en croyant couper
 * celle du point d'accès. On rend donc `null`, les capabilities PoE ne sont pas
 * déclarées, et l'utilisateur voit un port sans PoE plutôt qu'un PoE qui ment.
 *
 * Deux stratégies, dans cet ordre, et une seule est retenue :
 *
 * 1. **`identity`** — chaque `pethPsePortIndex` est un `ifIndex` de port physique
 *    existant. C'est le cas le plus fréquent et le seul qui soit vérifiable : on exige
 *    que *toutes* les prises tombent sur un port physique connu, et qu'aucun `ifIndex`
 *    ne soit revendiqué par deux prises.
 * 2. **`ordinal`** — les prises sont numérotées dans l'ordre des ports physiques. On ne
 *    l'accepte que si les deux listes ont **exactement** la même longueur : un switch
 *    24 ports dont 12 sont PoE ne dit pas *lesquels*, et une hypothèse à 50 % n'est pas
 *    une correspondance.
 */

import type { PoePortRef } from './poe-mib.mjs';

/** Ce que le rapprochement a conclu, et par quel chemin — la stratégie part dans les traces. */
export interface PoeMapping {
  strategy: 'identity' | 'ordinal';
  /** `ifIndex` → la prise PoE correspondante. */
  byIfIndex: ReadonlyMap<number, PoePortRef>;
}

/**
 * Rapproche l'inventaire des ports physiques et les prises PoE trouvées.
 *
 * @param physicalIfIndexes les `ifIndex` des ports physiques, dans l'ordre de l'agent
 * @param poePorts          les `{groupe, port}` réellement présents dans `pethPsePortTable`
 * @returns `null` quand aucune correspondance ne tient — c'est un résultat, pas un échec
 */
export function mapPoePorts(
  physicalIfIndexes: readonly number[],
  poePorts: readonly PoePortRef[],
): PoeMapping | null {
  if (physicalIfIndexes.length === 0 || poePorts.length === 0) return null;

  const identity = tryIdentity(physicalIfIndexes, poePorts);
  if (identity !== null) return { strategy: 'identity', byIfIndex: identity };

  const ordinal = tryOrdinal(physicalIfIndexes, poePorts);
  if (ordinal !== null) return { strategy: 'ordinal', byIfIndex: ordinal };

  return null;
}

/**
 * `pethPsePortIndex == ifIndex`.
 *
 * Rejetée dès qu'**une seule** prise tombe à côté : une correspondance partielle est
 * exactement le cas où l'on croit avoir compris. Rejetée aussi quand deux groupes
 * revendiquent le même `ifIndex`, ce qui arrive sur les châssis où le numéro de prise
 * repart à 1 dans chaque groupe — et où `identity` donnerait précisément la mauvaise
 * réponse pour tous les groupes sauf le premier.
 */
function tryIdentity(
  physicalIfIndexes: readonly number[],
  poePorts: readonly PoePortRef[],
): Map<number, PoePortRef> | null {
  const physical = new Set(physicalIfIndexes);
  const out = new Map<number, PoePortRef>();

  for (const ref of poePorts) {
    if (!physical.has(ref.port)) return null;
    if (out.has(ref.port)) return null;
    out.set(ref.port, ref);
  }

  return out;
}

/**
 * Les prises suivent l'ordre des ports physiques, une pour une.
 *
 * Le garde-fou est la longueur : autant de prises que de ports, sinon on ne sait pas
 * lesquels sont alimentés et l'hypothèse ne vaut rien. Les deux listes sont triées
 * — les ports par `ifIndex`, les prises par `{groupe, port}` — pour que l'ordre ne
 * dépende pas de celui dans lequel le `walk` a rendu ses lignes.
 */
function tryOrdinal(
  physicalIfIndexes: readonly number[],
  poePorts: readonly PoePortRef[],
): Map<number, PoePortRef> | null {
  if (physicalIfIndexes.length !== poePorts.length) return null;

  const ports = [...physicalIfIndexes].sort((a, b) => a - b);
  const refs = [...poePorts].sort((a, b) => (a.group - b.group) || (a.port - b.port));

  const out = new Map<number, PoePortRef>();
  ports.forEach((ifIndex, rank) => out.set(ifIndex, refs[rank]!));
  return out;
}

/** Les groupes PSE distincts d'une correspondance — ce qu'il faudra interroger pour la puissance. */
export function groupsOf(mapping: PoeMapping): number[] {
  const groups = new Set<number>();
  for (const ref of mapping.byIfIndex.values()) groups.add(ref.group);
  return [...groups].sort((a, b) => a - b);
}
