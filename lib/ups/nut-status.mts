/**
 * Parseur de `upsInfoStatus` — la chaîne `ups.status` de NUT, recopiée telle quelle
 * par DSM (annexe A §6a, piège n°2).
 *
 * Ce n'est **pas** une énumération : les jetons se combinent, séparés par une espace.
 * `"OL"` seul, `"OL CHRG"` en charge sur secteur, `"OB LB"` sur batterie et batterie
 * faible. Comparer la chaîne entière à `"OL"` marche donc tant que l'onduleur va bien,
 * et cesse de marcher exactement le jour où l'app doit servir à quelque chose.
 *
 * En production sur Synology, trois combinaisons ont été observées — `OL`, `OL CHRG`,
 * `OL DISCHRG` — mais le vocabulaire NUT est plus large et dépend du modèle d'onduleur.
 * Un jeton inconnu est **conservé sans faire échouer la lecture** : NUT en ajoute au fil
 * des versions, et perdre la charge batterie parce qu'un drapeau est nouveau serait
 * échanger une panne bénigne contre une panne grave.
 */

/** Les jetons `ups.status` documentés, avec ce qu'ils veulent dire. */
export const NUT_FLAGS = {
  OL: 'sur secteur',
  OB: 'sur batterie',
  LB: 'batterie faible',
  HB: 'batterie haute',
  RB: 'batterie à remplacer',
  CHRG: 'en charge',
  DISCHRG: 'en décharge',
  BYPASS: 'bypass — plus de protection',
  CAL: 'calibration en cours',
  OFF: 'onduleur éteint',
  OVER: 'surcharge',
  TRIM: 'tension d\'entrée rabaissée',
  BOOST: 'tension d\'entrée relevée',
  FSD: 'arrêt forcé demandé',
} as const;

export type NutFlag = keyof typeof NUT_FLAGS;

const KNOWN_FLAGS = new Set<string>(Object.keys(NUT_FLAGS));

/**
 * Le vocabulaire commun de la capability `ups_status` : les sept valeurs de
 * `upsOutputSource` (RFC 1628), sur lesquelles les trois dialectes se replient.
 * Défini ici parce que c'est le premier lecteur qui en a besoin ; le lot 4 le partagera.
 */
export type UpsStatus = 'normal' | 'battery' | 'bypass' | 'booster' | 'reducer' | 'off' | 'unknown';

/** Résultat du parsage. Données pures : sérialisable, comparable, sans méthode. */
export interface NutStatus {
  /** La chaîne telle que l'agent l'a rendue, ou `null` si l'OID était absent. */
  raw: string | null;
  /** Jetons reconnus, dédoublonnés, dans l'ordre où l'agent les a donnés. */
  flags: NutFlag[];
  /** Jetons non reconnus, conservés tels quels pour le diagnostic. */
  unknown: string[];
}

/** Un statut vide — ni drapeau, ni chaîne. Ce n'est pas « tout va bien », c'est « on ne sait pas ». */
export const UNKNOWN_STATUS: NutStatus = { raw: null, flags: [], unknown: [] };

/**
 * Découpe une chaîne `ups.status` en jetons.
 *
 * La casse est normalisée avant reconnaissance — NUT écrit en majuscules, mais un pont
 * tiers pourrait ne pas le faire, et rejeter `"ol"` coûterait la lecture entière.
 */
export function parseNutStatus(raw: string | null | undefined): NutStatus {
  if (raw === null || raw === undefined) return { ...UNKNOWN_STATUS };

  const flags: NutFlag[] = [];
  const unknown: string[] = [];

  for (const token of raw.split(/\s+/)) {
    if (token.length === 0) continue;
    const upper = token.toUpperCase();
    if (KNOWN_FLAGS.has(upper)) {
      const flag = upper as NutFlag;
      if (!flags.includes(flag)) flags.push(flag);
    } else if (!unknown.includes(token)) {
      unknown.push(token);
    }
  }

  return { raw, flags, unknown };
}

/** Vrai si le jeton est présent. */
export function hasFlag(status: NutStatus, flag: NutFlag): boolean {
  return status.flags.includes(flag);
}

/**
 * Replie les jetons NUT sur le vocabulaire commun.
 *
 * L'ordre de test est délibérément celui du **plus dégradé au moins dégradé** : un
 * onduleur peut annoncer `"OL BOOST"`, il est sur secteur *et* en correction de tension.
 * La capability ne porte qu'une valeur ; elle doit porter celle qui décrit le risque.
 *
 * Une chaîne vide ou faite de jetons tous inconnus rend `'unknown'`, jamais `'normal'` :
 * « je ne sais pas » ne doit pas se déguiser en « tout va bien ».
 */
export function toUpsStatus(status: NutStatus): UpsStatus {
  if (hasFlag(status, 'OFF')) return 'off';
  if (hasFlag(status, 'BYPASS')) return 'bypass';
  if (hasFlag(status, 'OB') || hasFlag(status, 'DISCHRG')) return 'battery';
  if (hasFlag(status, 'BOOST')) return 'booster';
  if (hasFlag(status, 'TRIM')) return 'reducer';
  if (hasFlag(status, 'OL')) return 'normal';
  return 'unknown';
}

/** Les quatre alarmes que les jetons NUT permettent de dériver (plan §3.2). */
export interface UpsAlarms {
  /** `OB` ou `DISCHRG` — l'événement qui déclenche les Flows de coupure. */
  onBattery: boolean;
  /** `LB` — NUT le lève selon les seuils `batteryChargeLow` / `batteryRuntimeLow`. */
  batteryLow: boolean;
  overload: boolean;
  replaceBattery: boolean;
}

/**
 * Dérive les alarmes des seuls jetons.
 *
 * Volontairement indépendant des mesures : une charge à 0 % ne doit **jamais** faire
 * naître une alarme ici. Le 0 d'un `null` mal casté est précisément ce qui a déclenché
 * de fausses alertes de coupure en pleine nuit sur les apps précédentes (plan §8.5).
 */
export function toUpsAlarms(status: NutStatus): UpsAlarms {
  return {
    onBattery: hasFlag(status, 'OB') || hasFlag(status, 'DISCHRG'),
    batteryLow: hasFlag(status, 'LB'),
    overload: hasFlag(status, 'OVER'),
    replaceBattery: hasFlag(status, 'RB'),
  };
}
