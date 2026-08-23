/**
 * Lecture d'un onduleur relayé par un NAS Synology.
 *
 * Seul endroit qui connaisse à la fois les OID de la branche `6574.4` et le domaine :
 * au-dessus, le device manipule un snapshot, jamais un OID ni un octet.
 *
 * Deux conversions vivent ici, et **nulle part ailleurs** :
 * - le décodage `Opaque Float` de Synology, délégué à `lib/snmp/opaque.mts` ;
 * - la normalisation de l'autonomie **secondes → minutes**. Quatre sources emploient
 *   quatre unités (annexe A §6d) ; laisser filer les secondes vers la couche capability
 *   reviendrait à y réimporter la question, une fois par dialecte.
 *
 * 🔴 `null` reste `null` de bout en bout. Une mesure absente n'est pas zéro : 0 % de
 * batterie déclenche `alarm_battery` **et** `alarm_ups_onbattery` — une fausse alerte
 * de coupure de courant, en pleine nuit (plan §8.5).
 */

import { toNumber } from '../snmp/opaque.mjs';
import { SYNOLOGY_UPS_OID } from './synology-mib.mjs';
import {
  parseNutStatus,
  toUpsAlarms,
  toUpsStatus,
  type NutStatus,
  type UpsAlarms,
  type UpsStatus,
} from './nut-status.mjs';

/** Ce qu'un agent SNMP peut rendre pour un objet. Identique au `SnmpValue` du client. */
export type SnmpValue = string | number | Buffer | null;

/**
 * Le strict nécessaire que le lecteur demande au transport.
 *
 * Décrit structurellement plutôt qu'importé : le `SnmpClient` du socle le satisfait sans
 * rien déclarer, et un objet de test de trois lignes aussi. Le lecteur reste donc
 * testable sans réseau — c'est la seule façon d'épingler les conversions d'unité, qui
 * sont ce qui casse en silence.
 */
export interface SnmpSource {
  get(oids: string[]): Promise<Map<string, SnmpValue>>;
}

/** Identité de l'onduleur. Lue au pairing puis au rythme lent : elle ne bouge pas. */
export interface SynologyUpsIdentity {
  model: string | null;
  manufacturer: string | null;
  serial: string | null;
}

/** Ce qui doit être relu vite (~10 s) : un passage sur batterie se voit en secondes. */
export interface SynologyUpsLive {
  /** Les jetons NUT bruts, conservés pour le diagnostic et le tampon de traces. */
  nut: NutStatus;
  /** Le repli sur le vocabulaire commun de `ups_status`. */
  status: UpsStatus;
  alarms: UpsAlarms;
  /** `upsInfoAlarm` — texte libre de NUT, presque toujours vide. */
  alarmText: string | null;
  /** Charge de la batterie, en %. */
  batteryCharge: number | null;
  /** Autonomie restante, **en minutes** — normalisée depuis les secondes de l'agent. */
  runtimeMinutes: number | null;
  /** Charge de sortie, en % de la puissance nominale. */
  load: number | null;
}

/** Ce qui peut être relu lentement (~5 min) : tensions, températures, seuils. */
export interface SynologyUpsDetail {
  /** Seuil de charge sous lequel NUT lève `LB`, en %. */
  batteryChargeLow: number | null;
  /** Seuil d'autonomie `LB`, **en minutes** — l'agent le donne en secondes lui aussi. */
  runtimeLowMinutes: number | null;
  /** ⚠️ Tension **batterie** (DC). Synology n'expose pas la tension de sortie. */
  batteryVoltage: number | null;
  batteryVoltageNominal: number | null;
  /** Capacité de la batterie, en Ah. */
  batteryCapacity: number | null;
  /** Courant batterie (DC), en A. Négatif en décharge sur certains modèles. */
  batteryCurrent: number | null;
  batteryTemperature: number | null;
  /** Température de l'onduleur. Absente sur la plupart des modèles d'entrée de gamme. */
  upsTemperature: number | null;
}

/** Tout ce qu'un cycle complet apprend de l'onduleur. */
export interface SynologyUpsSnapshot extends SynologyUpsIdentity, SynologyUpsLive, SynologyUpsDetail {}

const IDENTITY_OIDS = [
  SYNOLOGY_UPS_OID.deviceModel,
  SYNOLOGY_UPS_OID.deviceManufacturer,
  SYNOLOGY_UPS_OID.deviceSerial,
];

const LIVE_OIDS = [
  SYNOLOGY_UPS_OID.infoStatus,
  SYNOLOGY_UPS_OID.infoAlarm,
  SYNOLOGY_UPS_OID.batteryChargeValue,
  SYNOLOGY_UPS_OID.batteryRuntimeValue,
  SYNOLOGY_UPS_OID.infoLoadValue,
];

const DETAIL_OIDS = [
  SYNOLOGY_UPS_OID.batteryChargeLow,
  SYNOLOGY_UPS_OID.batteryRuntimeLow,
  SYNOLOGY_UPS_OID.batteryVoltageValue,
  SYNOLOGY_UPS_OID.batteryVoltageNominal,
  SYNOLOGY_UPS_OID.batteryCapacity,
  SYNOLOGY_UPS_OID.batteryCurrent,
  SYNOLOGY_UPS_OID.batteryTemperature,
  SYNOLOGY_UPS_OID.infoTemperature,
];

/** Les OID qu'un cycle complet interroge — utile au device pour dimensionner ses requêtes. */
export const SYNOLOGY_POLL_GROUPS = {
  identity: IDENTITY_OIDS,
  live: LIVE_OIDS,
  detail: DETAIL_OIDS,
} as const;

/**
 * Convertit l'autonomie de Synology, exprimée en **secondes**, vers les minutes de la
 * capability.
 *
 * Arrondi au dixième de minute : la capability affiche des minutes, et laisser traîner
 * les décimales d'un flottant ferait écrire une valeur à chaque poll, donc un point
 * Insights toutes les dix secondes pour rien.
 *
 * Une valeur négative rend `null` : elle n'existe pas physiquement, et la prendre pour
 * argent comptant afficherait une autonomie négative plutôt qu'« inconnue ».
 */
export function secondsToMinutes(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round((seconds / 60) * 10) / 10;
}

/** Une `DisplayString` non vide, ou `null`. Un nom vide n'est pas un nom. */
function asString(value: SnmpValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Une mesure numérique, bornée.
 *
 * Hors bornes ⇒ `null`, **jamais** une valeur ramenée dans l'intervalle : un décodage
 * qui part en vrille doit se voir comme « inconnu », pas se déguiser en 0 % — la borne
 * basse est précisément celle qui déclenche les alarmes.
 */
function asMeasure(value: SnmpValue | undefined, min: number, max: number): number | null {
  const n = toNumber(value ?? null);
  if (n === null || n < min || n > max) return null;
  return n;
}

/** Une valeur numérique sans borne utile (tension, courant, capacité). */
function asNumber(value: SnmpValue | undefined): number | null {
  return toNumber(value ?? null);
}

/**
 * Lit un onduleur derrière un Synology.
 *
 * Les erreurs de transport ne sont pas avalées : une injoignabilité doit remonter au
 * device, qui seul sait combien d'échecs consécutifs valent « indisponible ».
 */
export class SynologyUpsReader {
  constructor(private readonly source: SnmpSource) {}

  async readIdentity(): Promise<SynologyUpsIdentity> {
    const values = await this.source.get(IDENTITY_OIDS);
    return this.decodeIdentity(values);
  }

  /** Le groupe rapide : état secteur/batterie, autonomie, charge. */
  async readLive(): Promise<SynologyUpsLive> {
    const values = await this.source.get(LIVE_OIDS);
    return this.decodeLive(values);
  }

  /** Le groupe lent : seuils, tensions, températures. */
  async readDetail(): Promise<SynologyUpsDetail> {
    const values = await this.source.get(DETAIL_OIDS);
    return this.decodeDetail(values);
  }

  /** Un cycle complet, en une seule requête. Utilisé au pairing et au rythme lent. */
  async read(): Promise<SynologyUpsSnapshot> {
    const values = await this.source.get([...IDENTITY_OIDS, ...LIVE_OIDS, ...DETAIL_OIDS]);
    return {
      ...this.decodeIdentity(values),
      ...this.decodeLive(values),
      ...this.decodeDetail(values),
    };
  }

  private decodeIdentity(values: Map<string, SnmpValue>): SynologyUpsIdentity {
    return {
      model: asString(values.get(SYNOLOGY_UPS_OID.deviceModel)),
      manufacturer: asString(values.get(SYNOLOGY_UPS_OID.deviceManufacturer)),
      serial: asString(values.get(SYNOLOGY_UPS_OID.deviceSerial)),
    };
  }

  private decodeLive(values: Map<string, SnmpValue>): SynologyUpsLive {
    const nut = parseNutStatus(asString(values.get(SYNOLOGY_UPS_OID.infoStatus)));
    return {
      nut,
      status: toUpsStatus(nut),
      alarms: toUpsAlarms(nut),
      alarmText: asString(values.get(SYNOLOGY_UPS_OID.infoAlarm)),
      batteryCharge: asMeasure(values.get(SYNOLOGY_UPS_OID.batteryChargeValue), 0, 100),
      // 🔴 la seule conversion d'unité de ce fichier — et la seule de toute la lecture.
      runtimeMinutes: secondsToMinutes(asNumber(values.get(SYNOLOGY_UPS_OID.batteryRuntimeValue))),
      // La RFC 1628 admet jusqu'à 200 % de charge ; NUT ne borne rien.
      load: asMeasure(values.get(SYNOLOGY_UPS_OID.infoLoadValue), 0, 200),
    };
  }

  private decodeDetail(values: Map<string, SnmpValue>): SynologyUpsDetail {
    return {
      batteryChargeLow: asMeasure(values.get(SYNOLOGY_UPS_OID.batteryChargeLow), 0, 100),
      runtimeLowMinutes: secondsToMinutes(asNumber(values.get(SYNOLOGY_UPS_OID.batteryRuntimeLow))),
      batteryVoltage: asNumber(values.get(SYNOLOGY_UPS_OID.batteryVoltageValue)),
      batteryVoltageNominal: asNumber(values.get(SYNOLOGY_UPS_OID.batteryVoltageNominal)),
      batteryCapacity: asNumber(values.get(SYNOLOGY_UPS_OID.batteryCapacity)),
      batteryCurrent: asNumber(values.get(SYNOLOGY_UPS_OID.batteryCurrent)),
      batteryTemperature: asNumber(values.get(SYNOLOGY_UPS_OID.batteryTemperature)),
      upsTemperature: asNumber(values.get(SYNOLOGY_UPS_OID.infoTemperature)),
    };
  }
}
