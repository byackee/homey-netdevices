/**
 * Le contrat commun : ce qu'on sait d'un port, et sous quelle forme.
 *
 * Même rôle que `lib/ups/snapshot.mts` pour l'onduleur. Le lecteur remplit ces
 * structures, `capability-map.mts` les traduit en capabilities, le device ne fait que
 * les transporter. Aucune règle ne vit ici — seulement la forme, et l'engagement que
 * `null` y veut dire « on ne sait pas » et jamais « zéro ».
 */

import type { LinkState } from './if-mib.mjs';
import type { PoePortRef, PoeStatus } from './poe-mib.mjs';

/** Ce qui identifie un port et ne bouge pas d'un relevé à l'autre. */
export interface PortIdentity {
  /**
   * L'index IF-MIB.
   *
   * ⚠️ **Pas une identité durable.** Beaucoup d'agents renumérotent au redémarrage, et
   * certains décalent tout l'ordre quand un module optionnel est retiré. C'est pourquoi
   * l'identifiant Homey se bâtit sur le **nom** (voir `pairing.mts`) et pourquoi
   * `resolvePortIndex()` réaligne l'index à chaque relevé lent.
   */
  ifIndex: number;
  /** `ifName` — la forme courte, « Gi1/0/5 ». Ce qu'un administrateur reconnaît. */
  name: string | null;
  /** `ifDescr` — la forme longue. Seule chose disponible sur les agents sans `ifXTable`. */
  description: string | null;
  /** `ifAlias` — l'étiquette écrite par l'administrateur, quand il y en a une. */
  alias: string | null;
  /** `ifType`, brut. Sert à ne proposer que des prises physiques. */
  type: number | null;
}

/** Ce qu'un relevé rapide rapporte d'un port. */
export interface PortLive {
  link: LinkState;
  /** `ifAdminStatus` : le port est-il activé par configuration ? */
  adminUp: boolean | null;
  /** Compteur brut, **sans delta** : un Counter32 déborde et un faux delta est invisible. */
  errorsIn: number | null;
  errorsOut: number | null;
  /**
   * `ifHCInOctets` / `ifHCOutOctets`, bruts.
   *
   * 🔴 Ils portent **deux** informations, et il ne faut pas les confondre : leur valeur
   * sert à calculer un débit, mais c'est leur **présence** qui décide si les capabilities
   * de débit sont déclarées. Un premier relevé donne un compteur sans encore donner de
   * débit — déclarer sur le débit reviendrait à ne jamais déclarer.
   */
  octetsIn: number | null;
  octetsOut: number | null;
  /** `ifCounterDiscontinuityTime`, en centièmes de seconde depuis le démarrage de l'agent. */
  discontinuityTicks: number | null;
  /** `null` quand aucune correspondance PoE n'a été établie. Voir `poe-index.mts`. */
  poe: PoeReading | null;
}

/** Ce qu'on sait du PoE d'un port. */
export interface PoeReading {
  ref: PoePortRef;
  status: PoeStatus;
  /** `pethPsePortAdminEnable` : l'alimentation est-elle autorisée sur cette prise ? */
  adminEnabled: boolean | null;
  /**
   * `pethMainPseConsumptionPower` du **groupe**, en watts.
   *
   * 🔴 Ce n'est pas la consommation de ce port : RFC 3621 n'en publie aucune. Le titre
   * de la capability le dit, et c'est la seule raison pour laquelle cette valeur est
   * publiable sans mentir.
   */
  groupPowerWatts: number | null;
}

/** Le débit calculé, en Mbit/s. `null` tant qu'un calcul honnête est impossible. */
export interface PortThroughput {
  rxMbps: number | null;
  txMbps: number | null;
}

/** Tout ce qu'on sait d'un port à un instant donné. */
export interface PortSnapshot extends PortIdentity, PortLive, PortThroughput {
  /** Le débit négocié en Mbit/s, relevé au rythme lent — il ne bouge qu'au branchement. */
  speedMbps: number | null;
}

/** Un port dont rien n'a encore été lu : tout inconnu, sauf que c'est inconnu. */
export const UNKNOWN_LIVE: PortLive = {
  link: 'unknown',
  adminUp: null,
  errorsIn: null,
  errorsOut: null,
  octetsIn: null,
  octetsOut: null,
  discontinuityTicks: null,
  poe: null,
};

/** Le nom le plus parlant dont on dispose pour un port. */
export function portLabel(identity: PortIdentity): string {
  const alias = (identity.alias ?? '').trim();
  const name = (identity.name ?? '').trim();
  const descr = (identity.description ?? '').trim();
  // L'alias d'abord : c'est la seule des trois que l'utilisateur a écrite lui-même,
  // donc la seule qui parle de ce qui est *branché* plutôt que de la prise.
  if (alias !== '' && name !== '') return `${name} — ${alias}`;
  if (alias !== '') return alias;
  if (name !== '') return name;
  if (descr !== '') return descr;
  return `Port ${identity.ifIndex}`;
}

/**
 * Réaligne l'index d'un port sur l'inventaire courant.
 *
 * 🔴 La panne que ça évite est muette : un switch redémarre, renumérote ses interfaces,
 * et l'appareil Homey continue de relever — **un autre port**. Les courbes ne s'arrêtent
 * pas, elles deviennent fausses, et rien ne le signale.
 *
 * On se fie donc au nom, qui est stable, et l'index n'est qu'un raccourci qu'on vérifie.
 * Quand le nom ne se retrouve nulle part, on rend `null` plutôt que de retomber sur
 * l'index mémorisé : mieux vaut un appareil qui se dit indisponible qu'un appareil qui
 * publie les mesures du voisin.
 */
export function resolvePortIndex(
  inventory: readonly PortIdentity[],
  stored: { ifIndex: number; name: string | null; description: string | null },
): number | null {
  const wanted = keyOf(stored);

  // Le cas courant, et le moins cher : l'index mémorisé porte toujours le même nom.
  //
  // Ce chemin passe **avant** le contrôle d'homonymie, et c'est voulu. Quand un agent
  // publie deux ports du même nom, `disambiguate()` a fait de l'`ifIndex` une partie de
  // l'identité au pairing — c'est littéralement la seule chose qui les sépare. Rendre
  // `null` ici priverait ces appareils de tout relevé alors que rien n'a bougé.
  const atIndex = inventory.find((port) => port.ifIndex === stored.ifIndex);
  if (atIndex && keyOf(atIndex) === wanted) return atIndex.ifIndex;

  // Sans nom mémorisé, il n'y a rien à réaligner : on ne peut ni confirmer ni infirmer.
  // L'index mémorisé reste alors la seule piste, et seulement s'il existe encore.
  if (wanted === '') return atIndex ? atIndex.ifIndex : null;

  // L'index a bougé : il faut retrouver le port par son nom, et un seul candidat est
  // acceptable. Deux ports homonymes qui ont ET changé d'index ET perdu leur ancrage sont
  // indiscernables : choisir au hasard, c'est une chance sur deux de relever le voisin.
  const matches = inventory.filter((port) => keyOf(port) === wanted);
  return matches.length === 1 ? matches[0]!.ifIndex : null;
}

/** La clé de réalignement : le nom, à défaut la description. Vide quand ni l'un ni l'autre. */
function keyOf(port: { name: string | null; description: string | null }): string {
  const name = (port.name ?? '').trim();
  if (name !== '') return `n:${name}`;
  const descr = (port.description ?? '').trim();
  return descr === '' ? '' : `d:${descr}`;
}
