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

import { alarmParts, nutFlagParts } from './alarm-summary.mjs';
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
import type {
  SnmpSource,
  SnmpValue,
  UpsDetail,
  UpsIdentity,
  UpsLive,
  UpsSourceReader,
} from './snapshot.mjs';

/**
 * `SnmpValue` et `SnmpSource` viennent maintenant du contrat commun.
 *
 * Ils étaient déclarés ici quand Synology était la seule source ; les quatre dialectes
 * partagent désormais la même frontière avec le transport, et deux définitions
 * structurellement identiques mais distinctes finiraient par diverger sans que le
 * compilateur s'en plaigne. Ils restent réexportés : le lecteur reste testable sans
 * réseau, avec un objet de test de trois lignes.
 */
export type { SnmpSource, SnmpValue };

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
  /** Tension **secteur** (AC), en V. */
  inputVoltage: number | null;
  /** Tension nominale du secteur, en V — 230 en Europe. */
  inputVoltageNominal: number | null;
  /** Tension de **sortie** (AC), en V. */
  outputVoltage: number | null;
  /** ⚠️ Tension **batterie** (DC) — à ne pas confondre avec les deux precedentes. */
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
  SYNOLOGY_UPS_OID.inputVoltageValue,
  SYNOLOGY_UPS_OID.inputVoltageNominal,
  SYNOLOGY_UPS_OID.outputVoltageValue,
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
      inputVoltage: asNumber(values.get(SYNOLOGY_UPS_OID.inputVoltageValue)),
      inputVoltageNominal: asNumber(values.get(SYNOLOGY_UPS_OID.inputVoltageNominal)),
      outputVoltage: asNumber(values.get(SYNOLOGY_UPS_OID.outputVoltageValue)),
      batteryVoltage: asNumber(values.get(SYNOLOGY_UPS_OID.batteryVoltageValue)),
      batteryVoltageNominal: asNumber(values.get(SYNOLOGY_UPS_OID.batteryVoltageNominal)),
      batteryCapacity: asNumber(values.get(SYNOLOGY_UPS_OID.batteryCapacity)),
      batteryCurrent: asNumber(values.get(SYNOLOGY_UPS_OID.batteryCurrent)),
      batteryTemperature: asNumber(values.get(SYNOLOGY_UPS_OID.batteryTemperature)),
      upsTemperature: asNumber(values.get(SYNOLOGY_UPS_OID.infoTemperature)),
    };
  }
}

/**
 * Le lecteur Synology vu à travers le contrat commun.
 *
 * `SynologyUpsReader` reste ce qu'il est — riche, spécifique, il porte les jetons NUT
 * bruts, la tension nominale et la capacité en Ah dont aucune autre source ne dispose,
 * et le tampon de traces en a besoin pour le diagnostic. Cet adaptateur ne le remplace
 * pas : il en expose la part que les quatre dialectes ont en commun, pour que le device
 * puisse traiter un NAS, une carte RFC 1628 et un APC exactement de la même façon.
 *
 * La différence de forme est délibérée. `SynologyUpsReader` reçoit son transport au
 * constructeur ; `UpsSourceReader` le reçoit à chaque appel, parce que la liste ordonnée
 * de `sources.mts` est construite une fois pour toutes alors que le client, lui, est
 * propre à un appareil apparié.
 *
 * 🔴 Trois champs de `UpsDetail` restent `null` ici, et c'est la vérité de cette source :
 * **Synology ne relaie ni la tension d'entrée, ni la tension de sortie, ni la puissance.**
 * NUT les connaît parfois ; la MIB de DSM ne les publie pas. Le lot 4 s'en sert pour ne
 * pas déclarer une capability qu'il ne saurait pas remplir.
 */
export class SynologyUpsSource implements UpsSourceReader {
  readonly source = 'synology' as const;

  /**
   * « Y a-t-il un onduleur derrière ce NAS ? », en une seule requête.
   *
   * `upsInfoStatus` est le bon témoin : DSM ne publie la branche `6574.4` que si un
   * onduleur est effectivement configuré dans « Matériel & Alimentation ». Un NAS Synology
   * sans onduleur répond `noSuchObject`, et c'est exactement ce qu'on veut — l'app ne doit
   * pas proposer d'apparier un appareil qui n'a rien à dire.
   */
  async probe(client: SnmpSource): Promise<boolean> {
    const values = await client.get([SYNOLOGY_UPS_OID.infoStatus]);
    return asString(values.get(SYNOLOGY_UPS_OID.infoStatus)) !== null;
  }

  async readIdentity(client: SnmpSource): Promise<UpsIdentity> {
    return new SynologyUpsReader(client).readIdentity();
  }

  async readLive(client: SnmpSource): Promise<UpsLive> {
    const live = await new SynologyUpsReader(client).readLive();
    return {
      status: live.status,
      alarms: live.alarms,
      // NUT dit déjà tout en clair : les jetons non reconnus et le texte libre de
      // `upsInfoAlarm`, que le lecteur relevait sans que rien n'en fasse rien.
      alarmSummary: alarmParts({
        // Les jetons que les quatre booléens ne savent pas dire — bypass, calibration,
        // arrêt forcé — traduisibles ; les jetons inconnus passent en clair.
        parts: nutFlagParts(live.nut.flags, live.nut.unknown),
        // Le texte libre de `upsInfoAlarm`, quand NUT en met un. Repris mot pour mot :
        // c'est le firmware qui parle, pas l'app.
        texts: [live.alarmText],
      }),
      batteryCharge: live.batteryCharge,
      runtimeMinutes: live.runtimeMinutes,
      load: live.load,
    };
  }

  async readDetail(client: SnmpSource): Promise<UpsDetail> {
    const detail = await new SynologyUpsReader(client).readDetail();
    return {
      inputVoltage: detail.inputVoltage,
      outputVoltage: detail.outputVoltage,
      // La branche porte `upsInfoRealPowerValue`, mais le seul onduleur reel observe ne
      // publie que son **nominal** (390 W) et pas la mesure. Deriver des watts en
      // multipliant la charge par ce nominal donnerait un nombre plausible et faux :
      // `measure_power` doit rester une mesure, pas une estimation deguisee.
      outputPower: null,
      batteryVoltage: detail.batteryVoltage,
      // Deux sondes possibles, une seule case dans le contrat commun. Sur les onduleurs
      // domestiques visés, `ups.temperature` et `battery.temperature` décrivent la même
      // enceinte, et la plupart des modèles n'en publient qu'une des deux : préférer la
      // batterie puis se rabattre donne une température là où l'alternative — n'en garder
      // qu'une — n'en donnerait aucune sur la moitié du parc.
      batteryTemperature: detail.batteryTemperature ?? detail.upsTemperature,
      batteryChargeLow: detail.batteryChargeLow,
      runtimeLowMinutes: detail.runtimeLowMinutes,
    };
  }
}

/** L'instance partagée — la première de l'ordre d'essai de `sources.mts`. */
export const synologyUpsSource = new SynologyUpsSource();
