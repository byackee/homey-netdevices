/**
 * UPS-MIB (RFC 1628) — `1.3.6.1.2.1.33`.
 *
 * C'est la MIB standard des onduleurs : toute carte réseau digne de ce nom l'implémente,
 * quel que soit le constructeur. Là où la branche Synology ne marche que derrière un NAS,
 * celle-ci ouvre l'app à l'onduleur lui-même — et, contrairement au relais NAS, la carte
 * reste alimentée pendant toute la coupure (plan §3.8).
 *
 * Trois singularités de cette MIB méritent d'être nommées ici, parce qu'elles se paient
 * cher plus loin :
 *
 * 1. 🔴 **Les unités en dixièmes sont partielles.** `upsBatteryVoltage` est en décivolts,
 *    les fréquences en décihertz, les courants en déciampères — **mais les tensions
 *    d'entrée et de sortie sont en volts entiers**. Voir {@link RFC1628_TENTHS}.
 * 2. 🔴 **Les tables commencent à l'index 1, jamais 0.** Un onduleur monophasé n'a qu'une
 *    ligne, mais l'objet reste `...1.3.1`, pas `...1.3.0`. Copier un scalaire par réflexe
 *    donne un `noSuchObject` silencieux, donc une mesure « absente » qui existe.
 * 3. **`upsAlarmDescr` porte un OID, pas un texte.** Et cet OID peut pointer hors des 24
 *    alarmes de la RFC : APC et Eaton définissent les leurs sous leur MIB privée. Un
 *    décodeur qui ne connaît que la RFC doit dégrader, pas planter.
 *
 * OID vérifiés ligne à ligne sur le texte de la RFC (annexe A §1).
 */

const BASE = '1.3.6.1.2.1.33.1';

/** Les scalaires — ceux qui portent le `.0` final. */
export const RFC1628_UPS_OID = {
  // --- Identité `.1` — DisplayString ---------------------------------------
  /** upsIdentManufacturer — souvent le seul champ rempli sur l'entrée de gamme. */
  identManufacturer: `${BASE}.1.1.0`,
  /** upsIdentModel. */
  identModel: `${BASE}.1.2.0`,
  /** upsIdentUPSSoftwareVersion — firmware de l'onduleur. */
  identUpsSoftwareVersion: `${BASE}.1.3.0`,
  /** upsIdentAgentSoftwareVersion — firmware de la carte réseau, pas de l'onduleur. */
  identAgentSoftwareVersion: `${BASE}.1.4.0`,
  /** upsIdentName — ⚠️ nom **choisi par l'utilisateur**, RW. Ce n'est pas un modèle. */
  identName: `${BASE}.1.5.0`,
  /** upsIdentAttachedDevices — texte libre décrivant ce qui est branché. */
  identAttachedDevices: `${BASE}.1.6.0`,

  // --- Batterie `.2` -------------------------------------------------------
  /** upsBatteryStatus — voir {@link RFC1628_BATTERY_STATUS}. */
  batteryStatus: `${BASE}.2.1.0`,
  /** upsSecondsOnBattery — durée écoulée depuis le passage sur batterie, en secondes. */
  secondsOnBattery: `${BASE}.2.2.0`,
  /** upsEstimatedMinutesRemaining — 🔴 **déjà en minutes**. Aucune conversion. */
  estimatedMinutesRemaining: `${BASE}.2.3.0`,
  /** upsEstimatedChargeRemaining — %, 0..100. */
  estimatedChargeRemaining: `${BASE}.2.4.0`,
  /** upsBatteryVoltage — 🔴 **décivolts** (0,1 V). Tension **batterie** (DC). */
  batteryVoltage: `${BASE}.2.5.0`,
  /** upsBatteryCurrent — 0,1 A, `Integer32` **signé** : négatif en décharge. */
  batteryCurrent: `${BASE}.2.6.0`,
  /** upsBatteryTemperature — °C, entier signé. Pas de dixièmes ici. */
  batteryTemperature: `${BASE}.2.7.0`,

  // --- Entrée `.3` ---------------------------------------------------------
  /** upsInputLineBads — Counter32 des passages hors tolérance. ⚠️ déborde à 2³². */
  inputLineBads: `${BASE}.3.1.0`,
  /** upsInputNumLines — 1 en monophasé, 3 en triphasé. */
  inputNumLines: `${BASE}.3.2.0`,

  // --- Sortie `.4` ---------------------------------------------------------
  /** upsOutputSource — 🔴 la source de vérité de `ups_status`. {@link RFC1628_OUTPUT_SOURCE}. */
  outputSource: `${BASE}.4.1.0`,
  /** upsOutputFrequency — 🔴 **décihertz** (0,1 Hz). */
  outputFrequency: `${BASE}.4.2.0`,
  /** upsOutputNumLines. */
  outputNumLines: `${BASE}.4.3.0`,

  // --- Alarmes `.6` --------------------------------------------------------
  /** upsAlarmsPresent — Gauge32 : combien de lignes la table porte en ce moment. */
  alarmsPresent: `${BASE}.6.1.0`,
} as const;

/**
 * Les colonnes de `upsInputTable`, indexées par `upsInputLineIndex`.
 *
 * 🔴 Ce sont des **préfixes** : il manque l'index de ligne. Passer par
 * {@link rfc1628Column} plutôt que concaténer à la main.
 */
export const RFC1628_INPUT_COLUMN = {
  /** upsInputFrequency — 🔴 0,1 Hz. */
  frequency: `${BASE}.3.3.1.2`,
  /** upsInputVoltage — 🔴 **volts RMS entiers**, surtout pas des dixièmes. */
  voltage: `${BASE}.3.3.1.3`,
  /** upsInputCurrent — 0,1 A. */
  current: `${BASE}.3.3.1.4`,
  /** upsInputTruePower — W entiers. */
  truePower: `${BASE}.3.3.1.5`,
} as const;

/** Les colonnes de `upsOutputTable`, indexées par `upsOutputLineIndex`. */
export const RFC1628_OUTPUT_COLUMN = {
  /** upsOutputVoltage — 🔴 **volts RMS entiers**. */
  voltage: `${BASE}.4.4.1.2`,
  /** upsOutputCurrent — 0,1 A. */
  current: `${BASE}.4.4.1.3`,
  /** upsOutputPower — W entiers. */
  power: `${BASE}.4.4.1.4`,
  /** upsOutputPercentLoad — % de la puissance nominale, 0..200. */
  percentLoad: `${BASE}.4.4.1.5`,
} as const;

/** Les colonnes de `upsAlarmTable`, indexées par `upsAlarmId`. */
export const RFC1628_ALARM_COLUMN = {
  /** upsAlarmDescr — ⚠️ un **OID**, pas un libellé. Voir {@link decodeAlarmOid}. */
  descr: `${BASE}.6.2.1.2`,
  /** upsAlarmTime — `TimeStamp`, en `sysUpTime` de l'agent. */
  time: `${BASE}.6.2.1.3`,
} as const;

/**
 * L'index de ligne par défaut.
 *
 * 🔴 **Un, pas zéro.** L'immense majorité des onduleurs visés est monophasée et n'a
 * qu'une ligne — mais elle porte quand même l'index 1. C'est le piège n°3 de l'annexe,
 * et il est silencieux : l'agent répond `noSuchObject`, le lecteur rend `null`, et la
 * tension d'entrée reste éternellement « inconnue » sans qu'aucune erreur ne remonte.
 */
export const RFC1628_DEFAULT_LINE = 1;

/** Compose l'OID d'une cellule à partir de sa colonne et de son index de ligne. */
export function rfc1628Column(column: string, index: number = RFC1628_DEFAULT_LINE): string {
  return `${column}.${index}`;
}

/**
 * Les objets exprimés en dixièmes — **la liste est close**.
 *
 * Documentation exécutable du piège n°1 : tout ce qui n'est pas ici est dans son unité
 * naturelle. En particulier `RFC1628_INPUT_COLUMN.voltage` et
 * `RFC1628_OUTPUT_COLUMN.voltage` en sont **délibérément absents**.
 */
export const RFC1628_TENTHS = [
  RFC1628_UPS_OID.batteryVoltage,
  RFC1628_UPS_OID.batteryCurrent,
  RFC1628_UPS_OID.outputFrequency,
  RFC1628_INPUT_COLUMN.frequency,
  RFC1628_INPUT_COLUMN.current,
  RFC1628_OUTPUT_COLUMN.current,
] as const;

/**
 * `upsOutputSource` — d'où sort le courant *en ce moment*.
 *
 * C'est la seule question à laquelle la RFC réponde sans ambiguïté, et c'est celle qui
 * décide de `ups_status`. `none(2)` veut dire « pas de sortie du tout » : l'onduleur est
 * là, il ne délivre rien.
 */
export const RFC1628_OUTPUT_SOURCE = {
  other: 1,
  none: 2,
  normal: 3,
  bypass: 4,
  battery: 5,
  booster: 6,
  reducer: 7,
} as const;

/** `upsBatteryStatus` — grossier, mais présent partout. */
export const RFC1628_BATTERY_STATUS = {
  unknown: 1,
  batteryNormal: 2,
  batteryLow: 3,
  batteryDepleted: 4,
} as const;

const ALARM_BASE = '1.3.6.1.2.1.33.1.6.3';

/**
 * Les 24 alarmes « bien connues » de la RFC, sous `upsWellKnownAlarms`.
 *
 * Ce sont les valeurs que `upsAlarmDescr` peut porter — et il peut en porter d'autres :
 * rien n'oblige un constructeur à s'y limiter (piège n°5 de l'annexe).
 */
export const RFC1628_ALARM = {
  batteryBad: `${ALARM_BASE}.1`,
  onBattery: `${ALARM_BASE}.2`,
  lowBattery: `${ALARM_BASE}.3`,
  depletedBattery: `${ALARM_BASE}.4`,
  tempBad: `${ALARM_BASE}.5`,
  inputBad: `${ALARM_BASE}.6`,
  outputBad: `${ALARM_BASE}.7`,
  outputOverload: `${ALARM_BASE}.8`,
  onBypass: `${ALARM_BASE}.9`,
  bypassBad: `${ALARM_BASE}.10`,
  outputOffAsRequested: `${ALARM_BASE}.11`,
  upsOffAsRequested: `${ALARM_BASE}.12`,
  chargerFailed: `${ALARM_BASE}.13`,
  upsOutputOff: `${ALARM_BASE}.14`,
  upsSystemOff: `${ALARM_BASE}.15`,
  fanFailure: `${ALARM_BASE}.16`,
  fuseFailure: `${ALARM_BASE}.17`,
  generalFault: `${ALARM_BASE}.18`,
  diagnosticTestFailed: `${ALARM_BASE}.19`,
  communicationsLost: `${ALARM_BASE}.20`,
  awaitingPower: `${ALARM_BASE}.21`,
  shutdownPending: `${ALARM_BASE}.22`,
  shutdownImminent: `${ALARM_BASE}.23`,
  testInProgress: `${ALARM_BASE}.24`,
} as const;

export type Rfc1628Alarm = keyof typeof RFC1628_ALARM;

const ALARM_BY_OID = new Map<string, Rfc1628Alarm>(
  (Object.entries(RFC1628_ALARM) as [Rfc1628Alarm, string][]).map(([name, oid]) => [oid, name]),
);

/**
 * Traduit la valeur d'un `upsAlarmDescr` en nom d'alarme RFC.
 *
 * Rend `null` pour tout OID hors des 24 — ce n'est **pas** une erreur : les
 * constructeurs définissent les leurs sous leur PEN, et un onduleur APC qui remonte une
 * alarme APC dans une table RFC est un onduleur qui fonctionne normalement. Faire
 * échouer la lecture pour ça échangerait une alarme non décodée contre une perte totale
 * de mesure (piège n°5 de l'annexe).
 *
 * L'OID est normalisé de son éventuel point initial : certains agents rendent
 * `.1.3.6.1...`, d'autres `1.3.6.1...`, et les deux désignent le même objet.
 */
export function decodeAlarmOid(oid: string | null): Rfc1628Alarm | null {
  if (oid === null) return null;
  return ALARM_BY_OID.get(oid.trim().replace(/^\./, '')) ?? null;
}
