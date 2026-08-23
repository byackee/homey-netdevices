/**
 * POWER-ETHERNET-MIB (RFC 3621) — `1.3.6.1.2.1.105`.
 *
 * ⚠️ Le piège que l'annexe §3 signale explicitement : **`pethMainPseTable` est sous
 * `pethObjects.3.1`**, donc `1.3.6.1.2.1.105.1.3.1`, et **pas** sous
 * `powerEthernetMIB.3` (`1.3.6.1.2.1.105.3`). Beaucoup de résumés se trompent là-dessus,
 * et une erreur de branche ne se voit pas : elle rend `null` pour toujours, exactement
 * comme un switch sans PoE.
 *
 * 🔴 **Il n'existe aucune puissance par port dans cette MIB.** RFC 3621 donne la
 * *classe* du port (`pethPsePortPowerClassifications`), pas ses watts. Les watts
 * existent chez Cisco (`cpeExtPsePortPwrConsumption`), chez HP, chez Juniper — chacun
 * sous sa MIB privée, chacun avec son échelle. Ce qui est standard, c'est la
 * consommation **du groupe PSE entier** (`pethMainPseConsumptionPower`). C'est donc
 * elle qu'on publie, sous un titre qui dit que c'est le groupe — et non un `measure_power`
 * qui se lirait comme la consommation de ce port-là.
 */

/** `pethPsePortTable` = `1.3.6.1.2.1.105.1.1.1`, indexé par `{groupe, port}`. */
export const PETH_PORT_TABLE = {
  /** 🔴 TruthValue **RW** : true(1) alimente, false(2) coupe. Voir `control.mts`. */
  adminEnable: '1.3.6.1.2.1.105.1.1.1.3',
  detectionStatus: '1.3.6.1.2.1.105.1.1.1.6',
  /** RW, hors périmètre : on ne réordonne pas les priorités d'alimentation d'un switch. */
  powerPriority: '1.3.6.1.2.1.105.1.1.1.7',
} as const;

/** `pethMainPseTable` = `1.3.6.1.2.1.105.1.3.1`, indexé par le seul numéro de groupe. */
export const PETH_MAIN_TABLE = {
  /** Puissance nominale du groupe, en watts. */
  power: '1.3.6.1.2.1.105.1.3.1.1.2',
  operStatus: '1.3.6.1.2.1.105.1.3.1.1.3',
  /** Consommation réelle du groupe, en watts. La seule mesure de puissance standard. */
  consumptionPower: '1.3.6.1.2.1.105.1.3.1.1.4',
  /** Seuil d'alerte, en % — RW, hors périmètre. */
  usageThreshold: '1.3.6.1.2.1.105.1.3.1.1.5',
} as const;

/** L'état PoE d'un port, tel que Homey le montrera. */
export type PoeStatus =
  | 'disabled'
  | 'searching'
  | 'delivering'
  | 'fault'
  | 'test'
  | 'otherFault'
  | 'unknown';

/**
 * `pethPsePortDetectionStatus` : disabled(1), searching(2), deliveringPower(3),
 * fault(4), test(5), otherFault(6).
 *
 * Comme pour le lien, une valeur hors table devient `'unknown'` plutôt que d'être
 * repliée sur `disabled` — « je ne sais pas » et « c'est coupé » n'envoient pas
 * l'utilisateur au même endroit.
 */
export function poeStatusOf(value: number | null): PoeStatus {
  switch (value) {
    case 1: return 'disabled';
    case 2: return 'searching';
    case 3: return 'delivering';
    case 4: return 'fault';
    case 5: return 'test';
    case 6: return 'otherFault';
    default: return 'unknown';
  }
}

/** `pethPsePortAdminEnable` est un TruthValue : true(1), false(2). */
export function poeEnabledOf(value: number | null): boolean | null {
  if (value === 1) return true;
  if (value === 2) return false;
  return null;
}

/** L'écriture du TruthValue, dans l'autre sens. */
export function truthValue(on: boolean): number {
  return on ? 1 : 2;
}

/** Une prise PoE, désignée comme la MIB la désigne : par son groupe **et** son port. */
export interface PoePortRef {
  group: number;
  port: number;
}

/** Instancie une colonne de `pethPsePortTable` sur une prise. */
export function poePortOid(column: string, ref: PoePortRef): string {
  return `${column}.${ref.group}.${ref.port}`;
}

/** Instancie une colonne de `pethMainPseTable` sur un groupe. */
export function poeMainOid(column: string, group: number): string {
  return `${column}.${group}`;
}

/**
 * Retrouve `{groupe, port}` dans l'OID complet rendu par un `walk`.
 *
 * L'index d'une ligne de `pethPsePortTable` est ce qui suit la colonne : deux
 * sous-identifiants, jamais un seul. Un OID qui n'en porte pas exactement deux n'est
 * pas une ligne de cette table et est ignoré — un agent qui rend autre chose sous cette
 * branche ne doit pas fabriquer un port fantôme.
 */
export function poeRefFromOid(column: string, oid: string): PoePortRef | null {
  if (!oid.startsWith(`${column}.`)) return null;
  const rest = oid.slice(column.length + 1).split('.');
  if (rest.length !== 2) return null;
  const group = Number(rest[0]);
  const port = Number(rest[1]);
  if (!Number.isInteger(group) || !Number.isInteger(port)) return null;
  return { group, port };
}
