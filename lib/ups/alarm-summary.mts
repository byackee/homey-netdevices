/**
 * Nommer ce qui ne va pas, plutôt que de se contenter d'un booléen.
 *
 * L'app décodait déjà les vingt-quatre alarmes de la RFC 1628, gardait les OID
 * constructeur qu'elle ne connaît pas, et savait même quand la table de l'agent
 * dépassait la fenêtre sondée — puis ne publiait que quatre booléens. Un utilisateur
 * apprenait qu'il n'y avait pas de surcharge, et rien du ventilateur en panne, du
 * chargeur qui a lâché ou de l'arrêt imminent.
 *
 * Un booléen nu peut dire que quelque chose ne va pas, jamais **quoi**.
 *
 * Deux règles, toutes deux payées sur `homey-netprinter` :
 *
 * 1. **Trier par gravité, pas par ordre de table.** Un agent rend ses alarmes dans son
 *    ordre à lui ; ce qui a arrêté l'appareil doit venir en premier.
 * 2. **Borner.** Certains agents en gardent une douzaine. Concaténées sans limite, une
 *    tuile faite pour être lue d'un coup d'œil devient un paragraphe.
 */

import type { Rfc1628Alarm } from './rfc1628-mib.mjs';

/** Au-delà, la tuile n'est plus lisible d'un coup d'œil. */
const MAX_ENTRIES = 5;
const MAX_CHARS = 200;

/**
 * Les alarmes RFC 1628, du plus grave au plus anodin.
 *
 * L'ordre est le contenu de ce fichier : il décide de ce que l'utilisateur voit en
 * premier quand plusieurs alarmes sont actives. Ce qui coupe ou va couper l'alimentation
 * passe avant ce qui décrit une usure.
 */
const SEVERITY: readonly Rfc1628Alarm[] = [
  // L'alimentation est déjà coupée, ou le sera dans l'instant.
  'shutdownImminent',
  'upsSystemOff',
  'upsOutputOff',
  'depletedBattery',
  'shutdownPending',
  // La charge n'est plus protégée, ou l'onduleur est en défaut franc.
  'onBypass',
  'bypassBad',
  'outputBad',
  'outputOverload',
  'generalFault',
  'fanFailure',
  'fuseFailure',
  'chargerFailed',
  'batteryBad',
  'tempBad',
  // La coupure est en cours mais la charge tient encore.
  'lowBattery',
  'onBattery',
  'inputBad',
  'awaitingPower',
  // Informatif : un état demandé, un test, une perte de dialogue.
  'communicationsLost',
  'diagnosticTestFailed',
  'testInProgress',
  'outputOffAsRequested',
  'upsOffAsRequested',
];

const LABEL: Record<Rfc1628Alarm, string> = {
  shutdownImminent: 'arrêt imminent',
  upsSystemOff: 'onduleur éteint',
  upsOutputOff: 'sortie coupée',
  depletedBattery: 'batterie épuisée',
  shutdownPending: 'arrêt programmé',
  onBypass: 'sur bypass, charge non protégée',
  bypassBad: 'bypass en défaut',
  outputBad: 'sortie hors tolérance',
  outputOverload: 'surcharge en sortie',
  generalFault: 'défaut général',
  fanFailure: 'ventilateur en panne',
  fuseFailure: 'fusible en défaut',
  chargerFailed: 'chargeur en panne',
  batteryBad: 'batterie à remplacer',
  tempBad: 'température anormale',
  lowBattery: 'batterie faible',
  onBattery: 'sur batterie',
  inputBad: 'secteur hors tolérance',
  awaitingPower: 'en attente du secteur',
  communicationsLost: 'dialogue interrompu',
  diagnosticTestFailed: 'test de diagnostic échoué',
  testInProgress: 'test en cours',
  outputOffAsRequested: 'sortie coupée à la demande',
  upsOffAsRequested: 'onduleur éteint à la demande',
};

const RANK = new Map(SEVERITY.map((name, index) => [name, index]));

/**
 * Les jetons NUT que les quatre booléens ne savent **pas** exprimer.
 *
 * `OB`, `LB`, `OVER` et `RB` ont déjà leur capability et leur déclencheur ; les nommer
 * ici ne dirait rien de neuf. Ceux-ci n'ont aucune autre porte de sortie : sans ce
 * résumé, un onduleur en bypass — donc qui ne protège plus rien — est indiscernable
 * d'un onduleur sain, et une calibration ressemble à une coupure.
 */
const NUT_LABEL: Record<string, string> = {
  BYPASS: 'sur bypass, charge non protégée',
  OFF: 'onduleur éteint',
  FSD: 'arrêt forcé demandé',
  CAL: 'calibration en cours',
  HB: 'batterie en surtension',
  TRIM: 'correction de tension haute',
  BOOST: 'correction de tension basse',
  CHRG: 'batterie en charge',
};

/** L'ordre d'affichage de ces jetons, du plus alarmant au plus anodin. */
const NUT_ORDER = ['FSD', 'OFF', 'BYPASS', 'HB', 'CAL', 'TRIM', 'BOOST', 'CHRG'];

/**
 * Traduit les jetons NUT porteurs d'information en libellés.
 *
 * Les jetons inconnus remontent tels quels : un jeton qu'on ne sait pas traduire reste
 * une information, et le taire serait pire que de l'afficher brut.
 */
export function nutFlagLabels(flags: readonly string[], unknown: readonly string[] = []): string[] {
  const known = NUT_ORDER.filter((flag) => flags.includes(flag)).map((flag) => NUT_LABEL[flag]!);
  return [...known, ...unknown];
}

export interface AlarmSummaryInput {
  /** Alarmes RFC reconnues. */
  named?: readonly Rfc1628Alarm[];
  /** Libellés déjà en clair — la chaîne NUT de Synology, le statut d'APC. */
  texts?: readonly (string | null | undefined)[];
  /** Nombre d'OID d'alarme non reconnus : une MIB constructeur qu'on ne sait pas lire. */
  foreign?: number;
  /** L'agent annonce plus d'alarmes que la fenêtre sondée n'en couvre. */
  truncated?: boolean;
}

/**
 * Construit la phrase que porte la capability.
 *
 * Rend `null` quand il n'y a rien à dire — et **pas** une chaîne vide : une capability
 * sans valeur ne doit pas être déclarée, sous peine d'afficher un champ vide en
 * permanence sur un onduleur qui va parfaitement bien.
 */
export function summariseAlarms(input: AlarmSummaryInput): string | null {
  const parts: string[] = [];

  for (const name of [...(input.named ?? [])].sort(
    (a, b) => (RANK.get(a) ?? 99) - (RANK.get(b) ?? 99),
  )) {
    parts.push(LABEL[name] ?? name);
  }

  for (const text of input.texts ?? []) {
    const trimmed = (text ?? '').trim();
    if (trimmed.length > 0 && !parts.includes(trimmed)) parts.push(trimmed);
  }

  // Une alarme qu'on ne sait pas nommer reste une alarme : la taire serait pire que
  // de l'annoncer sans son nom.
  const unnamed = input.foreign ?? 0;
  if (unnamed > 0) {
    parts.push(unnamed === 1 ? '1 alarme constructeur' : `${unnamed} alarmes constructeur`);
  }

  if (parts.length === 0) return null;

  const kept = parts.slice(0, MAX_ENTRIES);
  const dropped = parts.length - kept.length + (input.truncated ? 1 : 0);
  if (dropped > 0) kept.push(`+${dropped} autre${dropped > 1 ? 's' : ''}`);

  let summary = kept.join(' · ');
  if (summary.length > MAX_CHARS) summary = `${summary.slice(0, MAX_CHARS - 1).trimEnd()}…`;
  return summary;
}
