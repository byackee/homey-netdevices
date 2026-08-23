/**
 * Le contrat commun à toutes les sources d'onduleur.
 *
 * Quatre dialectes existent — Synology (chaîne NUT + Opaque Float), RFC 1628 (entiers,
 * unités en dixièmes), APC PowerNet (sentinelles au lieu d'absences), QNAP (non confirmé).
 * Chacun a son lecteur ; tous rendent **cette** forme. Rien au-dessus de cette frontière
 * ne doit savoir de quelle MIB la valeur provient.
 *
 * Deux règles portent tout le reste :
 *
 * 1. **`null` veut dire « on ne sait pas », et se propage.** Jamais `0`. Une charge à 0 %
 *    déclencherait l'alarme de batterie *et* celle de coupure secteur — une fausse alerte
 *    de panne de courant. Une batterie réellement vide vaut `0` ; une mesure absente vaut
 *    `null` ; les deux ne doivent jamais se confondre.
 * 2. **Les unités sont normalisées ici, pas plus haut.** L'autonomie est en **minutes**,
 *    quelle que soit la source : Synology la donne en secondes, la RFC 1628 en minutes,
 *    APC et CyberPower en centièmes de seconde. Les tensions sont en volts, les puissances
 *    en watts, les températures en °C.
 */

import type { UpsAlarms, UpsStatus } from './nut-status.mjs';

/** D'où vient la lecture. Sert au diagnostic et à l'affichage, jamais à la logique. */
export type UpsSource = 'synology' | 'rfc1628' | 'apc' | 'qnap';

/** Lu au pairing puis au rythme lent : ça ne bouge pas. */
export interface UpsIdentity {
  model: string | null;
  manufacturer: string | null;
  serial: string | null;
}

/**
 * Ce qui doit être relu vite (~10 s).
 *
 * Un passage sur batterie se mesure en secondes : c'est le déclencheur qui coupe les
 * appareils non essentiels, et il ne supporte pas un rythme de cinq minutes.
 */
export interface UpsLive {
  status: UpsStatus;
  alarms: UpsAlarms;
  /**
   * Ce qui ne va pas, nommé.
   *
   * Les quatre booléens d'`alarms` déclenchent les Flows ; celui-ci dit **quoi**. Sans
   * lui, l'app décode les vingt-quatre alarmes de la RFC puis les jette. `null` quand il
   * n'y a rien à signaler — la capability n'est alors pas déclarée.
   */
  alarmSummary: string | null;
  /** Charge de la batterie, en %. */
  batteryCharge: number | null;
  /** Autonomie restante, **en minutes**, quelle que soit l'unité de la source. */
  runtimeMinutes: number | null;
  /** Charge de sortie, en % de la puissance nominale. */
  load: number | null;
}

/** Ce qui peut attendre le rythme lent (~5 min) : tensions, températures, seuils. */
export interface UpsDetail {
  /** Tension d'entrée secteur (AC), en V. `null` chez Synology, qui ne l'expose pas. */
  inputVoltage: number | null;
  /** Tension de sortie (AC), en V. `null` chez Synology. */
  outputVoltage: number | null;
  /** Puissance de sortie, en W. Absente de beaucoup d'agents. */
  outputPower: number | null;
  /** ⚠️ Tension **batterie** (DC) — à ne pas confondre avec la tension de sortie. */
  batteryVoltage: number | null;
  batteryTemperature: number | null;
  /** Seuil de charge sous lequel la source déclare la batterie faible, en %. */
  batteryChargeLow: number | null;
  /** Seuil d'autonomie basse, **en minutes**. */
  runtimeLowMinutes: number | null;
}

/** Tout ce qu'un cycle complet apprend, plus la provenance. */
export interface UpsSnapshot extends UpsIdentity, UpsLive, UpsDetail {
  source: UpsSource;
}

/** Le strict nécessaire qu'un lecteur demande au transport. */
export type SnmpValue = string | number | Buffer | null;
export interface SnmpSource {
  get(oids: string[]): Promise<Map<string, SnmpValue>>;
}

/**
 * Ce que chaque source implémente.
 *
 * `probe` répond « cet appareil parle-t-il mon dialecte ? » par une seule lecture, et
 * c'est lui qui décide de l'ordre d'essai au pairing : Synology, puis RFC 1628, puis APC.
 */
export interface UpsSourceReader {
  readonly source: UpsSource;
  probe(client: SnmpSource): Promise<boolean>;
  readIdentity(client: SnmpSource): Promise<UpsIdentity>;
  readLive(client: SnmpSource): Promise<UpsLive>;
  readDetail(client: SnmpSource): Promise<UpsDetail>;
}

/** Une valeur qu'aucune source n'a su donner. Explicite, pour ne pas la confondre avec zéro. */
export const UNKNOWN_DETAIL: UpsDetail = {
  inputVoltage: null,
  outputVoltage: null,
  outputPower: null,
  batteryVoltage: null,
  batteryTemperature: null,
  batteryChargeLow: null,
  runtimeLowMinutes: null,
};
