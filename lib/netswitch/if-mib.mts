/**
 * IF-MIB (RFC 2863) — les OID d'un port, et rien d'autre.
 *
 * Séparé du lecteur pour la même raison que `lib/ups/rfc1628-mib.mts` l'est du sien :
 * une constante fausse ne lève jamais, elle rend `null` pour toujours. Rassemblées ici,
 * les valeurs se relisent d'un coup contre l'annexe (§4) au lieu d'être disséminées
 * dans des appels.
 *
 * Deux tables, et la distinction compte :
 *
 * - `ifTable` (`1.3.6.1.2.1.2.2.1`) existe depuis RFC 1213 : tout agent l'a.
 * - `ifXTable` (`1.3.6.1.2.1.31.1.1`) est l'extension RFC 2863. Elle porte `ifName`,
 *   `ifAlias`, `ifHighSpeed` et surtout les **Counter64** de trafic.
 *
 * 🔴 `ifHCInOctets` / `ifHCOutOctets` sont des Counter64, et SNMPv1 n'a pas ce type :
 *    un switch interrogé en v1 les perd **silencieusement** (annexe, piège 7). Le
 *    lecteur rend alors `null`, et `capability-map.mts` ne déclare pas les débits —
 *    plutôt que d'afficher zéro à vie.
 */

/** `ifNumber.0` — combien d'interfaces l'agent déclare. Sert de sonde « parle IF-MIB ». */
export const IF_NUMBER = '1.3.6.1.2.1.2.1.0';

/** Les colonnes d'`ifTable`, sans index. Un `.n` suffit à les instancier. */
export const IF_TABLE = {
  descr: '1.3.6.1.2.1.2.2.1.2',
  type: '1.3.6.1.2.1.2.2.1.3',
  speed: '1.3.6.1.2.1.2.2.1.5',
  /** 🔴 RW : écrire ici coupe un port. Voir `lib/netswitch/control.mts`. */
  adminStatus: '1.3.6.1.2.1.2.2.1.7',
  operStatus: '1.3.6.1.2.1.2.2.1.8',
  /**
   * Counter**32** d'octets — le repli quand l'agent ne sert pas d'`ifXTable`.
   *
   * 🔴 Beaucoup de switches n'implémentent que cette table : la RFC 2863 ne rend les
   * compteurs 64 bits obligatoires qu'au-delà de 20 Mbit/s, et une bonne part du parc
   * s'en dispense quand même. Relevé sur un vrai switch : ses compteurs d'erreurs, qui
   * viennent d'ici, remontaient — et son débit restait vide, parce que l'app ne
   * demandait que l'`ifXTable`.
   *
   * Il déborde pour de bon : 2³² octets, soit 34 secondes à 1 Gbit/s saturé. C'est
   * `lib/netswitch/throughput.mts` qui décide quand un recul est un débordement
   * rattrapable et quand il est indécidable.
   */
  inOctets: '1.3.6.1.2.1.2.2.1.10',
  /** Counter32 — voir {@link IF_TABLE.inOctets}. */
  outOctets: '1.3.6.1.2.1.2.2.1.16',
  inErrors: '1.3.6.1.2.1.2.2.1.14',
  outErrors: '1.3.6.1.2.1.2.2.1.20',
} as const;

/** Les colonnes d'`ifXTable`, sans index. */
export const IF_X_TABLE = {
  name: '1.3.6.1.2.1.31.1.1.1.1',
  /** Counter64 — absent en v1. */
  hcInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  /** Counter64 — absent en v1. */
  hcOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  /** En Mbit/s, et c'est la seule lecture juste au-delà de 4,29 Gbit/s. */
  highSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  /** L'étiquette que l'administrateur a écrite sur le port. Le meilleur nom qui soit. */
  alias: '1.3.6.1.2.1.31.1.1.1.18',
  /**
   * `ifCounterDiscontinuityTime` : la date du dernier saut de compteur.
   *
   * 🔴 C'est ce qui rend un débit calculable honnêtement. Sans elle, un agent
   * redémarré fait passer un compteur de 10 To à 0 pour un débit négatif, ou —
   * pire — un `Math.abs()` mal placé le fait passer pour une pointe de trafic.
   */
  discontinuityTime: '1.3.6.1.2.1.31.1.1.1.19',
} as const;

/** L'état du lien, tel que Homey le montrera. Les sept valeurs de `ifOperStatus`, sans ajout. */
export type LinkState =
  | 'up'
  | 'down'
  | 'testing'
  | 'unknown'
  | 'dormant'
  | 'notPresent'
  | 'lowerLayerDown';

/**
 * `ifOperStatus` : up(1), down(2), testing(3), unknown(4), dormant(5), notPresent(6),
 * lowerLayerDown(7).
 *
 * Une valeur hors table devient `'unknown'`, qui est une **valeur du vocabulaire** et
 * non une absence : un port dont l'état est illisible est un port dont on ne sait rien,
 * ce qui n'est pas la même chose qu'un port éteint.
 */
export function linkStateOf(value: number | null): LinkState {
  switch (value) {
    case 1: return 'up';
    case 2: return 'down';
    case 3: return 'testing';
    case 5: return 'dormant';
    case 6: return 'notPresent';
    case 7: return 'lowerLayerDown';
    default: return 'unknown';
  }
}

/** `ifAdminStatus` : up(1), down(2), testing(3). `null` quand l'agent ne l'a pas rendu. */
export function adminUpOf(value: number | null): boolean | null {
  if (value === null) return null;
  if (value === 1) return true;
  if (value === 2) return false;
  // testing(3) n'est ni allumé ni éteint. Le dire inconnu vaut mieux que trancher.
  return null;
}

/**
 * Les `ifType` qui désignent un port physique qu'on peut brancher.
 *
 * Le pairing ne doit offrir que ça : une boucle locale, un VLAN, un tunnel ou un
 * agrégat sont des interfaces au sens de la MIB, pas des prises au sens de
 * l'utilisateur. Un switch 24 ports qui en propose 60 est un pairing qu'on abandonne.
 *
 * ethernetCsmacd(6) couvre le Fast, le Gigabit et le 10G modernes — la plupart des
 * agents récents ne rendent plus que celui-là. Les trois autres restent parce que des
 * firmwares plus anciens les rendent encore.
 */
export const PHYSICAL_IF_TYPES: ReadonlySet<number> = new Set([
  6,   // ethernetCsmacd
  62,  // fastEther
  69,  // fastEtherFX
  117, // gigabitEthernet (déprécié au profit de 6, encore vu)
]);

export function isPhysicalPort(ifType: number | null): boolean {
  return ifType !== null && PHYSICAL_IF_TYPES.has(ifType);
}

/**
 * Le débit négocié, en Mbit/s.
 *
 * 🔴 `ifSpeed` est un Gauge32 : il **plafonne à 4 294 967 295 bit/s**, soit ~4,29 Gbit/s
 * (annexe §4). Un port 10G y est indiscernable d'un port 4,29G, et un agent conforme y
 * répond littéralement `4294967295`. `ifHighSpeed`, en Mbit/s, est la seule lecture juste
 * au-delà — on la préfère donc **dès qu'elle existe**, pas seulement en cas de plafond :
 * elle est exacte partout, et c'est une branche de moins à se tromper.
 *
 * Un lien qui n'a pas négocié rend `0`, ce qui est une vraie mesure — « pas de débit » —
 * et non une absence. On la garde telle quelle.
 */
export const IF_SPEED_CEILING = 4_294_967_295;

export function speedMbps(highSpeed: number | null, speed: number | null): number | null {
  if (highSpeed !== null && Number.isFinite(highSpeed) && highSpeed >= 0) return highSpeed;
  if (speed === null || !Number.isFinite(speed) || speed < 0) return null;
  return Math.round(speed / 1_000_000);
}
