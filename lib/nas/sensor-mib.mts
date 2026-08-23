/**
 * ENTITY-SENSOR-MIB (RFC 3433) — `1.3.6.1.2.1.99` — la température, quand l'hôte en a une.
 *
 * HOST-RESOURCES-MIB **ne publie aucune température**. Un NAS qui chauffe est pourtant
 * exactement ce qu'on veut savoir, et la seule façon standard de le lire est cette
 * table-ci : chaque capteur physique y porte sa valeur, son unité, son échelle, sa
 * précision et son état. Les hôtes qui n'en ont pas ne répondent rien — la capability
 * n'est alors pas déclarée, ce qui est le comportement voulu.
 *
 * ⚠️ **Ces OID ne sont pas recoupés au texte de la RFC dans ce dépôt** : l'annexe A ne
 * couvre pas ENTITY-SENSOR-MIB. Le garde-fou n'est donc pas la confiance, c'est la
 * structure de la lecture : {@link decodeSensor} n'accepte une valeur **que** si la même
 * ligne annonce `celsius(8)` et `ok(1)`. Un sous-arbre mal deviné ne rend pas une
 * température fausse : il ne rend rien du tout, et la capability disparaît. C'est la
 * seule forme d'OID non vérifié qu'on puisse se permettre ici.
 *
 * Trois pièges, tous traités dans ce fichier :
 *
 * 1. 🔴 **La valeur brute n'est pas la mesure.** Elle se lit
 *    `value × 10^exposant(scale) / 10^precision`. Un capteur qui rend `3125` avec
 *    `precision = 2` vaut 31,25 °C ; le prendre tel quel donnerait « 3125 °C », et le
 *    prendre en ignorant l'échelle donnerait des ordres de grandeur au hasard.
 * 2. 🔴 **L'échelle de la RFC n'est pas l'échelle SI.** `EntitySensorDataScale` liste
 *    `exa(14)` **avant** `peta(15)`, à l'envers des préfixes SI. Un exposant calculé par
 *    `(scale - 9) × 3` est donc juste partout sauf sur ces deux valeurs. La table
 *    {@link SCALE_EXPONENT} les épelle une par une plutôt que de le calculer.
 * 3. 🔴 **`unavailable(2)` et `nonoperational(3)` ne sont pas des zéros.** Un capteur
 *    hors service rend `null`, jamais la dernière valeur ni 0 °C — qui se lirait comme
 *    un NAS très froid plutôt que comme un capteur muet.
 */

const BASE = '1.3.6.1.2.1.99.1.1.1';

/**
 * Les colonnes de `entPhySensorTable`, indexées par `entPhysicalIndex`.
 *
 * 🔴 Des **préfixes** : il leur manque l'index de ligne.
 */
export const SENSOR_COLUMN = {
  /** entPhySensorType — l'unité mesurée. Voir {@link SENSOR_TYPE}. */
  type: `${BASE}.1`,
  /** entPhySensorScale — le préfixe SI. Voir {@link SCALE_EXPONENT}. */
  scale: `${BASE}.2`,
  /** entPhySensorPrecision — nombre de décimales portées par la valeur entière, 0..9. */
  precision: `${BASE}.3`,
  /** entPhySensorValue — 🔴 **pas** la mesure : la mantisse. */
  value: `${BASE}.4`,
  /** entPhySensorOperStatus — voir {@link SENSOR_STATUS}. */
  operStatus: `${BASE}.5`,
} as const;

/** La racine à parcourir pour découvrir les capteurs d'un hôte. */
export const SENSOR_TABLE = BASE;

/** `EntitySensorDataType`. Seul `celsius` nous intéresse ; les autres servent à écarter. */
export const SENSOR_TYPE = {
  other: 1,
  unknown: 2,
  voltsAC: 3,
  voltsDC: 4,
  amperes: 5,
  watts: 6,
  hertz: 7,
  celsius: 8,
  percentRH: 9,
  rpm: 10,
  cmm: 11,
  truthvalue: 12,
} as const;

/** `EntitySensorStatus`. Seul `ok` autorise à lire la valeur. */
export const SENSOR_STATUS = {
  ok: 1,
  unavailable: 2,
  nonoperational: 3,
} as const;

/**
 * `EntitySensorDataScale` → exposant décimal.
 *
 * 🔴 Épelée, pas calculée. La RFC place `exa(14)` avant `peta(15)`, ce qui inverse leurs
 * exposants par rapport à l'ordre des préfixes SI. Une formule `(scale - 9) × 3` donnerait
 * 10¹⁵ pour `exa` et 10¹⁸ pour `peta` — un facteur mille sur deux valeurs qu'aucun capteur
 * de température n'emploiera jamais, donc une erreur qu'aucun test réel n'attraperait.
 * Elle est corrigée ici pour que le fichier reste juste si quelqu'un s'en sert un jour
 * pour lire des watts.
 */
export const SCALE_EXPONENT: Readonly<Record<number, number>> = {
  1: -24, // yocto
  2: -21, // zepto
  3: -18, // atto
  4: -15, // femto
  5: -12, // pico
  6: -9, //  nano
  7: -6, //  micro
  8: -3, //  milli
  9: 0, //   units
  10: 3, //  kilo
  11: 6, //  mega
  12: 9, //  giga
  13: 12, // tera
  14: 18, // exa   ⚠️ oui, avant peta — c'est l'ordre de la RFC
  15: 15, // peta
  16: 21, // zetta
  17: 24, // yotta
};

/** Une ligne de `entPhySensorTable`, telle que le parcours la rend. */
export interface SensorRow {
  index: number;
  type: number | null;
  scale: number | null;
  precision: number | null;
  value: number | null;
  operStatus: number | null;
}

/**
 * Bornes physiques d'une température d'appareil, en °C.
 *
 * Hors bornes ⇒ `null`, **jamais** une valeur ramenée dans l'intervalle. Une lecture qui
 * part en vrille doit se voir comme « inconnue » : un capteur ramené à 150 °C se lirait
 * comme un incendie, et ramené à −40 °C comme une salle serveur en Antarctique.
 */
export const TEMPERATURE_MIN = -40;
export const TEMPERATURE_MAX = 150;

/**
 * Décode une ligne de capteur en degrés Celsius, ou `null`.
 *
 * 🔴 Les trois refus sont la raison d'être de cette fonction, et aucun n'est
 * défensif « au cas où » :
 * - un type autre que `celsius(8)` : le même tableau porte des volts, des tours par
 *   minute et des pourcentages d'humidité, et 3 200 tr/min afficherait 3 200 °C ;
 * - un `operStatus` autre que `ok(1)` : un capteur débranché rend souvent `0` ;
 * - une valeur hors des bornes physiques.
 *
 * `scale` ou `precision` absents sont traités comme `units` et `0` : ce sont leurs
 * valeurs neutres, et un agent qui omet ces colonnes optionnelles rend bien une mesure
 * en degrés entiers.
 */
export function decodeSensor(row: SensorRow): number | null {
  if (row.type !== SENSOR_TYPE.celsius) return null;
  if (row.operStatus !== null && row.operStatus !== SENSOR_STATUS.ok) return null;
  if (row.value === null || !Number.isFinite(row.value)) return null;

  const exponent = row.scale === null ? 0 : SCALE_EXPONENT[row.scale];
  if (exponent === undefined) return null;

  const precision = row.precision ?? 0;
  if (!Number.isInteger(precision) || precision < 0 || precision > 9) return null;

  const celsius = (row.value * 10 ** exponent) / 10 ** precision;
  if (!Number.isFinite(celsius)) return null;
  if (celsius < TEMPERATURE_MIN || celsius > TEMPERATURE_MAX) return null;

  return Math.round(celsius * 10) / 10;
}

/**
 * La température retenue parmi tous les capteurs d'un hôte.
 *
 * 🔴 **La plus élevée**, et c'est une décision. Un NAS publie couramment plusieurs
 * capteurs — CPU, carte mère, un par disque. La moyenne diluerait précisément
 * l'information qu'on cherche : un seul disque à 58 °C est un disque qui va mourir, et
 * la moyenne de six capteurs le noierait à 38 °C. La valeur maximale est celle sur
 * laquelle on veut brancher une alerte.
 *
 * Rend `null` quand aucun capteur n'a livré de température exploitable — donc quand la
 * capability ne doit pas être déclarée.
 */
export function hottestSensor(rows: readonly SensorRow[]): number | null {
  let hottest: number | null = null;
  for (const row of rows) {
    const celsius = decodeSensor(row);
    if (celsius === null) continue;
    if (hottest === null || celsius > hottest) hottest = celsius;
  }
  return hottest;
}
