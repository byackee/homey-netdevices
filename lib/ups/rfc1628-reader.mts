/**
 * Lecture d'un onduleur qui parle la MIB standard RFC 1628.
 *
 * C'est le chemin sans NAS : la carte réseau de l'onduleur répond elle-même, elle est
 * alimentée par l'onduleur, et elle vit donc aussi longtemps que lui. Contrairement au
 * relais Synology, ce chemin voit **la fin** d'une coupure autant que son début
 * (plan §3.8).
 *
 * Ce fichier est le seul à connaître à la fois les OID de `1.3.6.1.2.1.33` et le
 * domaine ; au-dessus, on manipule un `UpsSnapshot` et rien d'autre.
 *
 * 🔴 Les trois pièges de cette MIB, tous traités ici et nulle part ailleurs :
 * - **les dixièmes sont partiels** : `upsBatteryVoltage` est en décivolts, mais
 *   `upsInputVoltage` et `upsOutputVoltage` sont en **volts entiers**. Un `fromTenths`
 *   de trop transforme un secteur à 230 V en 23 V, ce qui reste crédible ;
 * - **les tables s'indexent à 1** : `...1.3.1`, jamais `...1.3.0` ;
 * - **l'autonomie est déjà en minutes** : aucune conversion, contrairement à Synology
 *   (secondes) et APC (centièmes de seconde).
 */

import {
  RFC1628_ALARM_COLUMN,
  RFC1628_BATTERY_STATUS,
  RFC1628_DEFAULT_LINE,
  RFC1628_INPUT_COLUMN,
  RFC1628_OUTPUT_COLUMN,
  RFC1628_OUTPUT_SOURCE,
  RFC1628_UPS_OID,
  decodeAlarmOid,
  rfc1628Column,
  type Rfc1628Alarm,
} from './rfc1628-mib.mjs';
import { fromTenths } from './units.mjs';
import type { UpsAlarms, UpsStatus } from './nut-status.mjs';
import type {
  SnmpSource,
  SnmpValue,
  UpsDetail,
  UpsIdentity,
  UpsLive,
  UpsSourceReader,
} from './snapshot.mjs';

/**
 * Combien de lignes de `upsAlarmTable` on interroge à chaque cycle rapide.
 *
 * ⚠️ Compromis assumé, et il faut le dire. `upsAlarmId` est un identifiant **croissant**,
 * pas un rang : rien ne garantit que les alarmes en cours portent les identifiants 1..N.
 * Le parcours exact demanderait un `GETNEXT`, que le transport partagé n'expose pas — et
 * qu'on ne peut pas se permettre toutes les dix secondes de toute façon.
 *
 * Ce que ça coûte réellement est borné : `upsOutputSource` et `upsBatteryStatus` portent
 * déjà « sur batterie » et « batterie faible », soit les deux alarmes qui déclenchent des
 * Flows. Seules `outputOverload` et `batteryBad` dépendent de la table, et sur un
 * onduleur domestique — qui accumule quelques alarmes dans sa vie, pas des milliers —
 * elles tombent dans cette fenêtre.
 */
export const RFC1628_ALARM_PROBE_COUNT = 6;

const IDENTITY_OIDS = [
  RFC1628_UPS_OID.identManufacturer,
  RFC1628_UPS_OID.identModel,
];

/** Les identifiants d'alarme sondés, `1..RFC1628_ALARM_PROBE_COUNT`. Jamais 0. */
const ALARM_OIDS = Array.from(
  { length: RFC1628_ALARM_PROBE_COUNT },
  (_, i) => rfc1628Column(RFC1628_ALARM_COLUMN.descr, i + 1),
);

/** Une `DisplayString` non vide, ou `null`. Un nom vide n'est pas un nom. */
function asString(value: SnmpValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Un entier RFC 1628.
 *
 * Cette MIB n'emploie ni `Opaque Float` ni chaîne pour ses mesures : tout est entier.
 * Un tampon reçu ici signale donc un agent qui ment sur son dialecte, et vaut `null` —
 * pas une réinterprétation créative des octets.
 */
function asInteger(value: SnmpValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Buffer.isBuffer(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Une mesure bornée.
 *
 * Hors bornes ⇒ `null`, **jamais** une valeur ramenée dans l'intervalle : une lecture qui
 * part en vrille doit se voir comme « inconnue », pas se déguiser en 0 % — la borne basse
 * est précisément celle qui déclenche les alarmes (plan §8.5).
 */
function asMeasure(value: SnmpValue | undefined, min: number, max: number): number | null {
  const n = asInteger(value);
  if (n === null || n < min || n > max) return null;
  return n;
}

/**
 * Replie `upsOutputSource` sur le vocabulaire commun.
 *
 * `other(1)` rend `'unknown'` et non `'normal'` : la RFC l'emploie précisément quand
 * l'agent ne sait pas qualifier son état, et « je ne sais pas » ne doit jamais se
 * déguiser en « tout va bien ». Une valeur hors énumération rend `'unknown'` pour la
 * même raison.
 */
export function outputSourceToStatus(value: number | null): UpsStatus {
  switch (value) {
    case RFC1628_OUTPUT_SOURCE.none: return 'off';
    case RFC1628_OUTPUT_SOURCE.normal: return 'normal';
    case RFC1628_OUTPUT_SOURCE.bypass: return 'bypass';
    case RFC1628_OUTPUT_SOURCE.battery: return 'battery';
    case RFC1628_OUTPUT_SOURCE.booster: return 'booster';
    case RFC1628_OUTPUT_SOURCE.reducer: return 'reducer';
    default: return 'unknown';
  }
}

/** Ce que la table d'alarmes a livré : ce qu'on a su lire, et ce qu'on a laissé passer. */
export interface Rfc1628AlarmScan {
  /** Les alarmes RFC reconnues, dédoublonnées. */
  present: Rfc1628Alarm[];
  /** Les OID d'alarme non RFC — MIB privée d'un constructeur. Diagnostic uniquement. */
  foreign: string[];
  /** `upsAlarmsPresent` : ce que l'agent dit porter, `null` s'il ne le dit pas. */
  count: number | null;
  /** Vrai si l'agent annonce plus d'alarmes que la fenêtre sondée n'en couvre. */
  truncated: boolean;
}

/**
 * Décode les `upsAlarmDescr` lus.
 *
 * Un OID inconnu **n'interrompt rien** : il part dans `foreign` et la lecture continue.
 * Perdre la charge batterie parce qu'un constructeur a défini son alarme maison serait
 * échanger une gêne contre une panne.
 */
export function scanRfc1628Alarms(descriptors: (string | null)[], count: number | null): Rfc1628AlarmScan {
  const present: Rfc1628Alarm[] = [];
  const foreign: string[] = [];

  for (const raw of descriptors) {
    if (raw === null) continue;
    const alarm = decodeAlarmOid(raw);
    if (alarm !== null) {
      if (!present.includes(alarm)) present.push(alarm);
    } else if (!foreign.includes(raw)) {
      foreign.push(raw);
    }
  }

  const seen = present.length + foreign.length;
  return { present, foreign, count, truncated: count !== null && count > seen };
}

/** Options d'un lecteur RFC 1628. */
export interface Rfc1628ReaderOptions {
  /**
   * L'index de ligne interrogé dans les tables d'entrée et de sortie.
   *
   * 🔴 Vaut 1 par défaut — **pas 0**. Un onduleur monophasé n'a qu'une ligne, et cette
   * ligne porte l'index 1. Le triphasé (`upsInputNumLines` = 3) demanderait un lecteur
   * par ligne ; hors périmètre de la v1, qui vise le domestique.
   */
  line?: number;
}

/**
 * Lit un onduleur conforme à la RFC 1628.
 *
 * Les erreurs de transport ne sont pas avalées : une injoignabilité doit remonter au
 * device, qui seul sait combien d'échecs consécutifs valent « indisponible » — et qui
 * seul sait qu'une perte de contact pendant une coupure n'est pas une panne (plan §3.8).
 */
export class Rfc1628UpsReader implements UpsSourceReader {
  readonly source = 'rfc1628' as const;

  private readonly line: number;
  private readonly liveOids: string[];
  private readonly detailOids: string[];

  constructor(options: Rfc1628ReaderOptions = {}) {
    this.line = options.line ?? RFC1628_DEFAULT_LINE;
    this.liveOids = [
      RFC1628_UPS_OID.outputSource,
      RFC1628_UPS_OID.batteryStatus,
      RFC1628_UPS_OID.estimatedChargeRemaining,
      RFC1628_UPS_OID.estimatedMinutesRemaining,
      rfc1628Column(RFC1628_OUTPUT_COLUMN.percentLoad, this.line),
      RFC1628_UPS_OID.alarmsPresent,
      ...ALARM_OIDS,
    ];
    this.detailOids = [
      rfc1628Column(RFC1628_INPUT_COLUMN.voltage, this.line),
      rfc1628Column(RFC1628_OUTPUT_COLUMN.voltage, this.line),
      rfc1628Column(RFC1628_OUTPUT_COLUMN.power, this.line),
      RFC1628_UPS_OID.batteryVoltage,
      RFC1628_UPS_OID.batteryTemperature,
    ];
  }

  /** Les OID d'un cycle complet — utile au device pour dimensionner ses requêtes. */
  get pollGroups(): { identity: string[]; live: string[]; detail: string[] } {
    return { identity: [...IDENTITY_OIDS], live: [...this.liveOids], detail: [...this.detailOids] };
  }

  /**
   * « Cet appareil parle-t-il RFC 1628 ? », en une seule requête.
   *
   * On interroge les deux scalaires **obligatoires** de la MIB plutôt que l'identité :
   * `upsIdentManufacturer` est vide sur beaucoup de cartes d'entrée de gamme, et une
   * chaîne vide ne prouve rien. Une énumération dans ses bornes, elle, ne peut pas venir
   * d'un agent qui n'implémente pas cette MIB.
   */
  async probe(client: SnmpSource): Promise<boolean> {
    const values = await client.get([RFC1628_UPS_OID.outputSource, RFC1628_UPS_OID.batteryStatus]);
    const output = asInteger(values.get(RFC1628_UPS_OID.outputSource));
    const battery = asInteger(values.get(RFC1628_UPS_OID.batteryStatus));
    const outputOk = output !== null && output >= RFC1628_OUTPUT_SOURCE.other && output <= RFC1628_OUTPUT_SOURCE.reducer;
    const batteryOk = battery !== null && battery >= RFC1628_BATTERY_STATUS.unknown && battery <= RFC1628_BATTERY_STATUS.batteryDepleted;
    return outputOk || batteryOk;
  }

  /**
   * Identité.
   *
   * `serial` reste `null` : **la RFC 1628 n'a pas d'objet de numéro de série.**
   * `upsIdentName` existe, mais c'est un nom que l'utilisateur choisit et peut réécrire —
   * le prendre pour un identifiant matériel donnerait une clé d'appairage qui change le
   * jour où quelqu'un renomme son onduleur.
   */
  async readIdentity(client: SnmpSource): Promise<UpsIdentity> {
    const values = await client.get(IDENTITY_OIDS);
    return {
      model: asString(values.get(RFC1628_UPS_OID.identModel)),
      manufacturer: asString(values.get(RFC1628_UPS_OID.identManufacturer)),
      serial: null,
    };
  }

  /** Le groupe rapide (~10 s) : état secteur/batterie, autonomie, charge, alarmes. */
  async readLive(client: SnmpSource): Promise<UpsLive> {
    const values = await client.get(this.liveOids);
    const outputSource = asInteger(values.get(RFC1628_UPS_OID.outputSource));
    const batteryStatus = asInteger(values.get(RFC1628_UPS_OID.batteryStatus));
    const scan = scanRfc1628Alarms(
      ALARM_OIDS.map((oid) => asString(values.get(oid))),
      asInteger(values.get(RFC1628_UPS_OID.alarmsPresent)),
    );

    return {
      status: outputSourceToStatus(outputSource),
      alarms: this.decodeAlarms(scan, outputSource, batteryStatus),
      batteryCharge: asMeasure(values.get(RFC1628_UPS_OID.estimatedChargeRemaining), 0, 100),
      // 🔴 Déjà en minutes : la RFC est la seule source à ne demander aucune conversion.
      runtimeMinutes: asMeasure(values.get(RFC1628_UPS_OID.estimatedMinutesRemaining), 0, Number.MAX_SAFE_INTEGER),
      // La RFC borne explicitement `upsOutputPercentLoad` à 200 %.
      load: asMeasure(values.get(rfc1628Column(RFC1628_OUTPUT_COLUMN.percentLoad, this.line)), 0, 200),
    };
  }

  /** Le groupe lent (~5 min) : tensions, puissance, température. */
  async readDetail(client: SnmpSource): Promise<UpsDetail> {
    const values = await client.get(this.detailOids);
    return {
      // 🔴 Volts **entiers** — pas de `fromTenths` ici, sous peine d'un 230 V affiché 23 V.
      inputVoltage: asMeasure(values.get(rfc1628Column(RFC1628_INPUT_COLUMN.voltage, this.line)), 0, 1000),
      outputVoltage: asMeasure(values.get(rfc1628Column(RFC1628_OUTPUT_COLUMN.voltage, this.line)), 0, 1000),
      outputPower: asMeasure(values.get(rfc1628Column(RFC1628_OUTPUT_COLUMN.power, this.line)), 0, 100_000),
      // 🔴 Décivolts, eux. C'est la seule tension de cette MIB à l'être.
      batteryVoltage: fromTenths(asMeasure(values.get(RFC1628_UPS_OID.batteryVoltage), 0, 10_000)),
      batteryTemperature: asMeasure(values.get(RFC1628_UPS_OID.batteryTemperature), -50, 150),
      // La RFC ne publie pas ses seuils d'alerte dans les groupes vérifiés en annexe A §1 :
      // `upsConfig` n'y figure pas, et déclarer un OID non vérifié donnerait un seuil
      // parfaitement crédible et parfaitement faux. `null` dit la vérité.
      batteryChargeLow: null,
      runtimeLowMinutes: null,
    };
  }

  /**
   * Croise la table d'alarmes et les deux énumérations d'état.
   *
   * Les énumérations sont la source principale — elles sont obligatoires, scalaires, et
   * ne dépendent pas de la fenêtre d'identifiants sondée. La table ne fait qu'ajouter :
   * elle porte seule `outputOverload` et `batteryBad`.
   *
   * 🔴 Rien ici ne regarde une **mesure**. Une charge à 0 % ne doit jamais faire naître
   * une alarme : c'est exactement le `null` mal casté qui a déclenché de fausses alertes
   * de coupure en pleine nuit sur les apps précédentes (plan §8.5).
   */
  private decodeAlarms(scan: Rfc1628AlarmScan, outputSource: number | null, batteryStatus: number | null): UpsAlarms {
    const has = (alarm: Rfc1628Alarm): boolean => scan.present.includes(alarm);
    return {
      onBattery: outputSource === RFC1628_OUTPUT_SOURCE.battery || has('onBattery'),
      batteryLow:
        batteryStatus === RFC1628_BATTERY_STATUS.batteryLow ||
        batteryStatus === RFC1628_BATTERY_STATUS.batteryDepleted ||
        has('lowBattery') ||
        has('depletedBattery'),
      overload: has('outputOverload'),
      replaceBattery: has('batteryBad'),
    };
  }
}

/** L'instance partagée, sur la ligne 1 — celle que `sources.mts` met dans l'ordre d'essai. */
export const rfc1628UpsSource = new Rfc1628UpsReader();
