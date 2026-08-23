/**
 * SYNOLOGY-UPS-MIB — `1.3.6.1.4.1.6574.4`.
 *
 * C'est le chemin principal de l'app : l'utilisateur a déjà branché son onduleur en USB
 * sur le NAS et coché « SNMP » dans DSM. Rien à installer de plus. Le démon interne de
 * DSM est basé sur NUT, ce qui explique deux singularités de cette branche :
 *
 * - presque toutes les mesures sont des `Float` de `NET-SNMP-TC`, encodés sur le fil en
 *   `Opaque` propriétaire — voir {@link FLOAT_OIDS} et `lib/snmp/opaque.mts` ;
 * - `upsInfoStatus` n'est pas une énumération mais la **chaîne `ups.status` de NUT**,
 *   recopiée telle quelle — voir `lib/ups/nut-status.mts`.
 *
 * OID vérifiés en croisant la MIB officielle, l'article Paessler et le script de
 * production `kernelkaribou/synology-monitoring` (annexe A §6a).
 */

const BASE = '1.3.6.1.4.1.6574.4';

export const SYNOLOGY_UPS_OID = {
  // --- Identité `.1` — DisplayString ---------------------------------------
  /** upsDeviceModel — modèle de l'onduleur tel que NUT le rapporte. */
  deviceModel: `${BASE}.1.1.0`,
  /** upsDeviceManufacturer. */
  deviceManufacturer: `${BASE}.1.2.0`,
  /** upsDeviceSerial — vide sur beaucoup d'onduleurs d'entrée de gamme. */
  deviceSerial: `${BASE}.1.3.0`,

  // --- État `.2` -----------------------------------------------------------
  /** upsInfoStatus — chaîne NUT à jetons combinables (`"OL CHRG"`), pas un code. */
  infoStatus: `${BASE}.2.1.0`,
  /** upsInfoAlarm — texte libre, souvent vide. */
  infoAlarm: `${BASE}.2.2.0`,
  /** upsInfoTemperature — °C, Opaque Float. Absent sur la plupart des modèles. */
  infoTemperature: `${BASE}.2.11.0`,
  /** upsInfoLoadValue — charge en % de la puissance nominale, Opaque Float. */
  infoLoadValue: `${BASE}.2.12.1.0`,

  // --- Batterie `.3` -------------------------------------------------------
  /** upsBatteryChargeValue — % de charge, Opaque Float. La mesure la plus utile. */
  batteryChargeValue: `${BASE}.3.1.1.0`,
  /** upsBatteryChargeLow — seuil sous lequel NUT lève le jeton `LB`, en %. */
  batteryChargeLow: `${BASE}.3.1.2.0`,
  /** upsBatteryVoltageValue — tension **batterie** (DC), pas la tension de sortie. */
  batteryVoltageValue: `${BASE}.3.2.1.0`,
  /** upsBatteryVoltageNominal — tension nominale de la batterie (DC). */
  batteryVoltageNominal: `${BASE}.3.2.2.0`,
  /** upsBatteryCapacity — Ah. */
  batteryCapacity: `${BASE}.3.3.0`,
  /** upsBatteryCurrent — A DC. */
  batteryCurrent: `${BASE}.3.4.0`,
  /** upsBatteryTemperature — °C. */
  batteryTemperature: `${BASE}.3.5.0`,
  /**
   * upsBatteryRuntimeValue — autonomie restante.
   *
   * 🔴 En **secondes**, et c'est un `Integer32`, pas un Float : les deux exceptions de
   * cette MIB tombent sur le même objet. Trois autres sources emploient trois autres
   * unités (annexe A §6d) ; la normalisation en minutes a lieu dans le lecteur.
   */
  batteryRuntimeValue: `${BASE}.3.6.1.0`,
  /** upsBatteryRuntimeLow — seuil `LB` exprimé en secondes lui aussi. */
  batteryRuntimeLow: `${BASE}.3.6.2.0`,
} as const;

export type SynologyUpsField = keyof typeof SYNOLOGY_UPS_OID;

/**
 * Les objets encodés en `Opaque Float`.
 *
 * Sert de documentation exécutable : un objet qui n'est pas là arrive en entier ou en
 * chaîne, et le passer au décodeur Opaque rendrait `null` — donc « mesure inconnue »
 * pour une valeur pourtant lue. La liste est explicitement close par le `satisfies`.
 */
export const FLOAT_OIDS = [
  'infoTemperature',
  'infoLoadValue',
  'batteryChargeValue',
  'batteryChargeLow',
  'batteryVoltageValue',
  'batteryVoltageNominal',
  'batteryCapacity',
  'batteryCurrent',
  'batteryTemperature',
] as const satisfies readonly SynologyUpsField[];

/** Les deux objets en `Integer32` — et les seules valeurs en secondes de la branche. */
export const SECONDS_OIDS = [
  'batteryRuntimeValue',
  'batteryRuntimeLow',
] as const satisfies readonly SynologyUpsField[];
