/**
 * Lecture d'un onduleur APC qui ne parle que PowerNet.
 *
 * Troisième et dernier essai de l'ordre de détection : un APC moderne répond d'abord à la
 * RFC 1628, et c'est tant mieux — cette MIB-ci est plus riche mais moins portable. On
 * n'arrive ici que pour les cartes qui n'implémentent pas le standard.
 *
 * 🔴 Deux pièges, tous deux traités ici et nulle part ailleurs :
 *
 * 1. **Les sentinelles.** APC répond `255` (température) ou `4294967295` (TimeTicks) au
 *    lieu de `noSuchObject`. La requête réussit, la valeur est un entier valide, et rien
 *    ne la distingue d'une mesure sans la connaître. ⇒ `null`.
 * 2. **Les TimeTicks.** L'autonomie est en centièmes de seconde : `÷6000`. La RFC la
 *    donne en minutes et Synology en secondes — trois sources, trois unités, une seule
 *    frontière où les réconcilier (annexe A §6d).
 *
 * Et une décision qu'il faut assumer : **ce lecteur ne lit que ce que l'annexe A §2 a
 * vérifié**. PowerNet publie bien une tension de sortie, une puissance active et une
 * tension batterie, mais leurs OID n'ont pas été relus ligne à ligne. Les déclarer sur la
 * foi d'un résumé donnerait des mesures crédibles et fausses — pire que pas de mesure du
 * tout. Ils restent `null`, et le lot 4 ne déclarera donc pas les capabilities
 * correspondantes.
 */

import {
  APC_BATTERY_STATUS,
  APC_OUTPUT_STATUS,
  APC_TEMPERATURE_UNSUPPORTED,
  APC_TEST_STATUSES,
  APC_TIMETICKS_UNSUPPORTED,
  APC_UPS_OID,
} from './apc-mib.mjs';
import { fromTenths, timeTicksToMinutes } from './units.mjs';
import type { UpsAlarms, UpsStatus } from './nut-status.mjs';
import type {
  SnmpSource,
  SnmpValue,
  UpsDetail,
  UpsIdentity,
  UpsLive,
  UpsSourceReader,
} from './snapshot.mjs';

const IDENTITY_OIDS = [APC_UPS_OID.basicIdentModel];

const LIVE_OIDS = [
  APC_UPS_OID.basicOutputStatus,
  APC_UPS_OID.basicBatteryStatus,
  APC_UPS_OID.highPrecBatteryCapacity,
  APC_UPS_OID.advBatteryCapacity,
  APC_UPS_OID.advBatteryRunTimeRemaining,
  APC_UPS_OID.highPrecOutputLoad,
  APC_UPS_OID.advOutputLoad,
];

const DETAIL_OIDS = [
  APC_UPS_OID.advInputLineVoltage,
  APC_UPS_OID.advBatteryTemperature,
];

/** Les OID d'un cycle complet — utile au device pour dimensionner ses requêtes. */
export const APC_POLL_GROUPS = {
  identity: IDENTITY_OIDS,
  live: LIVE_OIDS,
  detail: DETAIL_OIDS,
} as const;

/** Une `DisplayString` non vide, ou `null`. */
function asString(value: SnmpValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Un entier PowerNet. Comme la RFC, cette MIB n'emploie que des entiers. */
function asInteger(value: SnmpValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Buffer.isBuffer(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Une mesure bornée. Hors bornes ⇒ `null`, jamais une valeur rabotée. */
function asMeasure(value: SnmpValue | undefined, min: number, max: number): number | null {
  const n = asInteger(value);
  if (n === null || n < min || n > max) return null;
  return n;
}

/**
 * La borne haute de plausibilité d'une température de batterie, en °C.
 *
 * Exportée pour être vérifiable : elle est aujourd'hui **sous** la sentinelle, donc elle
 * écarte `255` à elle seule et le test de sentinelle est une seconde couche. C'est
 * délibéré, mais fragile — l'élargir au-delà de 255 rendrait la sentinelle seule
 * responsable, et un test l'épingle pour que ce jour-là quelqu'un s'en rende compte.
 */
export const APC_TEMPERATURE_PLAUSIBLE_MAX = 150;

/** La borne basse. Une batterie sous −50 °C n'est pas une batterie qui fonctionne. */
export const APC_TEMPERATURE_PLAUSIBLE_MIN = -50;

/**
 * Lit la température batterie en écartant la sentinelle.
 *
 * 🔴 `255` n'est pas une température : c'est « pas de sonde ». Le test d'égalité stricte
 * vient **avant** le bornage, dans cet ordre, parce que c'est le seul des deux qui dise
 * *pourquoi* la valeur est rejetée — un jour où quelqu'un aura besoin de savoir si son
 * onduleur n'a pas de sonde ou si le décodage a dérapé, la différence comptera.
 */
export function apcTemperature(value: SnmpValue | undefined): number | null {
  const n = asInteger(value);
  if (n === null || n === APC_TEMPERATURE_UNSUPPORTED) return null;
  return n >= APC_TEMPERATURE_PLAUSIBLE_MIN && n <= APC_TEMPERATURE_PLAUSIBLE_MAX ? n : null;
}

/**
 * Lit une autonomie en `TimeTicks` en écartant la sentinelle.
 *
 * 🔴 Sans le test de sentinelle : `4294967295 ÷ 6000` = 715 827 minutes, soit 81 ans
 * d'autonomie affichés sur la tuile.
 */
export function apcRuntimeMinutes(value: SnmpValue | undefined): number | null {
  const ticks = asInteger(value);
  if (ticks === null || ticks === APC_TIMETICKS_UNSUPPORTED) return null;
  return timeTicksToMinutes(ticks);
}

/**
 * Replie les 28 valeurs de `upsBasicOutputStatus` sur les 7 du vocabulaire commun.
 *
 * Les regroupements ne sont pas arbitraires : ils répondent à « d'où vient le courant qui
 * alimente la charge, en ce moment ». `ecoMode`, `eConversion`, `powerSavingMode` et les
 * spot modes alimentent depuis le secteur ⇒ `normal`. Les bypass, quelle qu'en soit la
 * cause, laissent la charge sans protection ⇒ `bypass`. Tout ce qui décharge la batterie,
 * y compris un test, ⇒ `battery` : la capability dit la vérité, et c'est
 * {@link apcAlarms} qui décide de ne pas réveiller les Flows pour un test.
 *
 * `unknown(1)` et toute valeur hors énumération rendent `'unknown'`, jamais `'normal'`.
 */
export function outputStatusToUpsStatus(value: number | null): UpsStatus {
  switch (value) {
    case APC_OUTPUT_STATUS.onLine:
    case APC_OUTPUT_STATUS.ecoMode:
    case APC_OUTPUT_STATUS.hotStandby:
    case APC_OUTPUT_STATUS.powerSavingMode:
    case APC_OUTPUT_STATUS.spotMode:
    case APC_OUTPUT_STATUS.eConversion:
    case APC_OUTPUT_STATUS.chargerSpotmode:
    case APC_OUTPUT_STATUS.inverterSpotmode:
    case APC_OUTPUT_STATUS.activeLoad:
      return 'normal';

    case APC_OUTPUT_STATUS.onBattery:
    case APC_OUTPUT_STATUS.onBatteryTest:
    case APC_OUTPUT_STATUS.batteryDischargeSpotmode:
    case APC_OUTPUT_STATUS.distributedEnergyReserve:
    case APC_OUTPUT_STATUS.selfTest:
      return 'battery';

    case APC_OUTPUT_STATUS.softwareBypass:
    case APC_OUTPUT_STATUS.switchedBypass:
    case APC_OUTPUT_STATUS.hardwareFailureBypass:
    case APC_OUTPUT_STATUS.emergencyStaticBypass:
    case APC_OUTPUT_STATUS.staticBypassStandby:
      return 'bypass';

    case APC_OUTPUT_STATUS.onSmartBoost:
      return 'booster';

    case APC_OUTPUT_STATUS.onSmartTrim:
      return 'reducer';

    case APC_OUTPUT_STATUS.timedSleeping:
    case APC_OUTPUT_STATUS.off:
    case APC_OUTPUT_STATUS.rebooting:
    case APC_OUTPUT_STATUS.sleepingUntilPowerReturn:
    case APC_OUTPUT_STATUS.inverterStandby:
    case APC_OUTPUT_STATUS.chargerOnly:
      return 'off';

    default:
      return 'unknown';
  }
}

const TEST_STATUSES = new Set<number>(APC_TEST_STATUSES);

/**
 * Dérive les alarmes des deux énumérations d'état, et **d'aucune mesure**.
 *
 * `onBattery` exclut délibérément les états de test : la charge est bien sur batterie —
 * `status` le dit — mais c'est un test programmé, pas une coupure, et le déclencheur
 * branché dessus coupe les appareils non essentiels de l'utilisateur.
 *
 * `overload` reste `false` : **PowerNet n'expose aucun objet de surcharge dans le sous-
 * ensemble vérifié en annexe A §2.** On pourrait le déduire d'une charge supérieure à
 * 100 %, mais dériver une alarme d'une mesure est exactement ce que le plan §8.5
 * interdit — c'est ainsi qu'un `null` casté en `0` allume une alarme de coupure.
 */
export function apcAlarms(outputStatus: number | null, batteryStatus: number | null): UpsAlarms {
  const onBattery =
    outputStatusToUpsStatus(outputStatus) === 'battery' &&
    !(outputStatus !== null && TEST_STATUSES.has(outputStatus));

  return {
    onBattery,
    batteryLow: batteryStatus === APC_BATTERY_STATUS.batteryLow,
    overload: false,
    replaceBattery:
      batteryStatus === APC_BATTERY_STATUS.batteryInFaultCondition ||
      batteryStatus === APC_BATTERY_STATUS.noBatteryPresent,
  };
}

/**
 * Lit un onduleur APC PowerNet.
 *
 * Les erreurs de transport ne sont pas avalées : seul le device sait combien d'échecs
 * consécutifs valent « indisponible ».
 */
export class ApcUpsReader implements UpsSourceReader {
  readonly source = 'apc' as const;

  /**
   * « Cet appareil parle-t-il PowerNet ? », en une seule requête.
   *
   * Les deux énumérations `Basic` sont les objets les plus anciens et les plus
   * universellement implémentés de la branche : une carte APC qui ne répondrait à
   * aucune des deux ne nous servirait à rien de toute façon.
   */
  async probe(client: SnmpSource): Promise<boolean> {
    const values = await client.get([APC_UPS_OID.basicOutputStatus, APC_UPS_OID.basicBatteryStatus]);
    const output = asInteger(values.get(APC_UPS_OID.basicOutputStatus));
    const battery = asInteger(values.get(APC_UPS_OID.basicBatteryStatus));
    const outputOk = output !== null && output >= APC_OUTPUT_STATUS.unknown && output <= APC_OUTPUT_STATUS.selfTest;
    const batteryOk = battery !== null && battery >= APC_BATTERY_STATUS.unknown && battery <= APC_BATTERY_STATUS.noBatteryPresent;
    return outputOk || batteryOk;
  }

  /**
   * Identité.
   *
   * `manufacturer` vaut la constante `'APC'` : ce n'est pas une supposition mais la
   * définition même de la branche interrogée — le PEN 318 du registre IANA *est* American
   * Power Conversion. PowerNet n'a pas d'objet « constructeur », et laisser `null` ferait
   * afficher un onduleur sans marque alors que le seul fait d'avoir répondu ici la donne.
   *
   * `serial` reste `null` : `upsAdvIdentSerialNumber` existe dans PowerNet mais n'a pas
   * été relu en annexe A §2, et un identifiant faux est pire qu'un identifiant absent.
   */
  async readIdentity(client: SnmpSource): Promise<UpsIdentity> {
    const values = await client.get(IDENTITY_OIDS);
    return {
      model: asString(values.get(APC_UPS_OID.basicIdentModel)),
      manufacturer: 'APC',
      serial: null,
    };
  }

  /** Le groupe rapide (~10 s). */
  async readLive(client: SnmpSource): Promise<UpsLive> {
    const values = await client.get(LIVE_OIDS);
    const outputStatus = asInteger(values.get(APC_UPS_OID.basicOutputStatus));
    const batteryStatus = asInteger(values.get(APC_UPS_OID.basicBatteryStatus));

    // 🔴 `highPrec` est en **dixièmes** de %, `adv` en % entiers : 873 et 87 décrivent la
    // même batterie. On préfère le premier quand il répond, et on ne les additionne
    // jamais — `??` et non `||`, sinon une batterie réellement à 0 % basculerait sur
    // l'autre objet au lieu d'être rapportée telle quelle.
    const highPrecCharge = fromTenths(asMeasure(values.get(APC_UPS_OID.highPrecBatteryCapacity), 0, 1000));
    const charge = highPrecCharge ?? asMeasure(values.get(APC_UPS_OID.advBatteryCapacity), 0, 100);

    const highPrecLoad = fromTenths(asMeasure(values.get(APC_UPS_OID.highPrecOutputLoad), 0, 2000));
    const load = highPrecLoad ?? asMeasure(values.get(APC_UPS_OID.advOutputLoad), 0, 200);

    return {
      status: outputStatusToUpsStatus(outputStatus),
      alarms: apcAlarms(outputStatus, batteryStatus),
      batteryCharge: charge,
      runtimeMinutes: apcRuntimeMinutes(values.get(APC_UPS_OID.advBatteryRunTimeRemaining)),
      load,
    };
  }

  /**
   * Le groupe lent (~5 min).
   *
   * Quatre des sept champs restent `null` faute d'OID vérifié — voir l'en-tête. Ce n'est
   * pas une omission : c'est la seule réponse honnête, et le lot 4 s'en sert pour ne pas
   * déclarer une capability qu'il ne saurait pas remplir (`removeCapability` détruit
   * l'historique Insights de façon irréversible).
   */
  async readDetail(client: SnmpSource): Promise<UpsDetail> {
    const values = await client.get(DETAIL_OIDS);
    return {
      // V entiers, comme la RFC — pas de dixièmes ici.
      inputVoltage: asMeasure(values.get(APC_UPS_OID.advInputLineVoltage), 0, 1000),
      outputVoltage: null,
      outputPower: null,
      batteryVoltage: null,
      batteryTemperature: apcTemperature(values.get(APC_UPS_OID.advBatteryTemperature)),
      batteryChargeLow: null,
      runtimeLowMinutes: null,
    };
  }
}

/** L'instance partagée — celle que `sources.mts` met en dernier dans l'ordre d'essai. */
export const apcUpsSource = new ApcUpsReader();
