/**
 * Du snapshot commun au plan de capabilities Homey.
 *
 * **Aucun import Homey.** Toutes les règles qui décident de ce que l'utilisateur voit
 * vivent ici, et aucune n'a besoin d'une app qui tourne — c'est le motif de
 * `capability-map.mts` de netprinter, et c'est ce qui rend ces règles testables.
 *
 * Trois décisions portent tout le reste :
 *
 * 1. 🔴 **Une capability sans valeur n'est pas déclarée.** Jamais posée à `null` pour
 *    être retirée plus tard : `removeCapability` détruit l'historique Insights de façon
 *    irréversible. Le tri se fait au pairing, à partir de ce que la source a réellement
 *    su lire, et {@link reconcileCapabilities} n'a délibérément aucun chemin de retrait.
 * 2. **`null` veut dire « on ne sait pas » et se propage jusqu'ici.** Une charge à 0 %
 *    est une batterie vide ; une charge absente est `null`. Aucune alarme n'est dérivée
 *    d'une mesure — elles viennent toutes de `snapshot.alarms`, que le lecteur a bâti à
 *    partir de drapeaux, pas de chiffres (plan §8.5).
 * 3. **Ce que la source ne sait pas produire n'est pas déclaré non plus.** Le contrat
 *    `UpsAlarms` porte quatre booléens, sans `null` possible : un APC, qui n'expose
 *    aucune surcharge, afficherait donc une alarme éternellement fausse. La table
 *    {@link ALARM_SUPPORT} transcrit la colonne « — » du plan §3.2.
 */

import type { UpsAlarms, UpsStatus } from './nut-status.mjs';
import type { UpsSnapshot, UpsSource } from './snapshot.mjs';

/** Un titre dans les trois langues de l'app. */
export interface LocalisedTitle {
  en: string;
  fr: string;
  nl: string;
}

/** Une capability et la valeur à y écrire. `null` = « on ne sait pas », rendu inconnu par Homey. */
export interface CapabilityValue {
  id: string;
  value: number | string | boolean | null;
}

/** Ce qui part dans `capabilitiesOptions` pour une capability donnée. */
export interface CapabilityOptions {
  title: LocalisedTitle;
}

/** Pourquoi une capability candidate n'a pas été déclarée. Sert au diagnostic, pas à la logique. */
export interface OmittedCapability {
  id: string;
  /** `no-value` : la source n'a rien rendu. `unsupported-by-source` : ce dialecte ne l'expose pas. */
  reason: 'no-value' | 'unsupported-by-source';
}

/** Le résultat du mapping d'un snapshot. */
export interface CapabilityPlan {
  /** Toutes les capabilities que cet onduleur doit porter, dans l'ordre d'affichage. */
  capabilities: string[];
  /** Les valeurs à écrire, une par entrée de {@link capabilities}, dans le même ordre. */
  values: CapabilityValue[];
  /**
   * Les `capabilitiesOptions` à poser. Homey ne génère **rien** pour les
   * sous-capabilities (`measure_voltage.input`) : ni Flow card, ni titre distinct.
   * Sans ces titres, trois lignes s'affichent toutes « Voltage ».
   */
  options: Map<string, CapabilityOptions>;
  /**
   * `{ batteries: ['INTERNAL'] }` dès que `measure_battery` ou `alarm_battery` est
   * déclarée — Homey l'exige, et c'est ici légitime : la batterie est dans l'appareil.
   * `null` quand aucune des deux n'est déclarée, auquel cas la clé ne doit pas être posée.
   */
  energy: { batteries: string[] } | null;
  /** Les capabilities candidates écartées, avec la raison. */
  omitted: OmittedCapability[];
}

/**
 * Le vocabulaire de `ups_status`, dérivé du type et non recopié.
 *
 * Le `Record<UpsStatus, true>` est un garde-fou de compilation : si une huitième valeur
 * apparaît dans `UpsStatus`, ce fichier cesse de compiler au lieu de laisser une valeur
 * silencieusement absente de l'énumération déclarée à Homey.
 */
const STATUS_DECLARED: Record<UpsStatus, true> = {
  normal: true,
  battery: true,
  bypass: true,
  booster: true,
  reducer: true,
  off: true,
  unknown: true,
};

export const UPS_STATUS_VALUES = Object.keys(STATUS_DECLARED) as UpsStatus[];

/**
 * Quelles alarmes chaque dialecte sait réellement produire (plan §3.2, colonnes « — »).
 *
 * APC n'expose aucun équivalent de `upsAlarmOutputOverload` ; QNAP n'est pas confirmé, on
 * ne lui accorde donc que les deux alarmes que les quatre dialectes exposent tous. Déclarer
 * ce qu'on ne sait pas lire donnerait une alarme figée à `false` pour toujours — pire qu'une
 * absence, parce qu'elle a l'air de dire « tout va bien ».
 */
const ALARM_SUPPORT: Record<UpsSource, Record<keyof UpsAlarms, boolean>> = {
  synology: { onBattery: true, batteryLow: true, overload: true, replaceBattery: true },
  rfc1628: { onBattery: true, batteryLow: true, overload: true, replaceBattery: true },
  apc: { onBattery: true, batteryLow: true, overload: false, replaceBattery: true },
  qnap: { onBattery: true, batteryLow: true, overload: false, replaceBattery: false },
};

/** Une mesure numérique : son id de capability et le champ du snapshot qui la porte. */
interface MeasureRule {
  id: string;
  read: (snapshot: UpsSnapshot) => number | null;
  /** Posé seulement pour les sous-capabilities, que Homey n'intitule pas tout seul. */
  title?: LocalisedTitle;
}

/**
 * Les mesures, dans l'ordre d'affichage.
 *
 * ⚠️ `measure_voltage.output` lit `outputVoltage` (AC) et **jamais** `batteryVoltage` (DC).
 * Le plan §3.2 signale que Synology n'expose que la seconde ; le contrat du snapshot les
 * sépare déjà, et on lui donne sa propre sous-capability plutôt que de l'afficher sous une
 * étiquette qui ment.
 */
const MEASURES: readonly MeasureRule[] = [
  { id: 'measure_battery', read: (s) => s.batteryCharge },
  { id: 'ups_runtime', read: (s) => s.runtimeMinutes },
  { id: 'ups_load', read: (s) => s.load },
  {
    id: 'measure_voltage.input',
    read: (s) => s.inputVoltage,
    title: { en: 'Input voltage', fr: 'Tension d\'entrée', nl: 'Ingangsspanning' },
  },
  {
    id: 'measure_voltage.output',
    read: (s) => s.outputVoltage,
    title: { en: 'Output voltage', fr: 'Tension de sortie', nl: 'Uitgangsspanning' },
  },
  {
    id: 'measure_voltage.battery',
    read: (s) => s.batteryVoltage,
    title: { en: 'Battery voltage', fr: 'Tension batterie', nl: 'Accuspanning' },
  },
  { id: 'measure_power', read: (s) => s.outputPower },
  { id: 'measure_temperature', read: (s) => s.batteryTemperature },
];

/** Les alarmes, dans l'ordre d'affichage, et le drapeau du snapshot qui les porte. */
const ALARMS: ReadonlyArray<{ id: string; flag: keyof UpsAlarms }> = [
  { id: 'alarm_battery', flag: 'batteryLow' },
  { id: 'alarm_ups_onbattery', flag: 'onBattery' },
  { id: 'alarm_ups_overload', flag: 'overload' },
  { id: 'alarm_ups_replace_battery', flag: 'replaceBattery' },
];

/** Les capabilities imposant `energy.batteries` dès qu'elles sont déclarées. */
const BATTERY_CAPABILITIES = ['measure_battery', 'alarm_battery'];

/**
 * Bâtit le plan de capabilities d'un snapshot.
 *
 * À appeler **au pairing**, sur un cycle complet (identité + live + détail) : ce qui est
 * décidé ici est définitif pour la vie de l'appareil. Un snapshot partiel — un `readLive()`
 * seul, par exemple — écarterait toutes les tensions et priverait l'utilisateur de mesures
 * que son onduleur sait pourtant donner.
 */
export function planCapabilities(snapshot: UpsSnapshot): CapabilityPlan {
  const capabilities: string[] = [];
  const values: CapabilityValue[] = [];
  const options = new Map<string, CapabilityOptions>();
  const omitted: OmittedCapability[] = [];

  const declare = (id: string, value: CapabilityValue['value']) => {
    capabilities.push(id);
    values.push({ id, value });
  };

  // L'état est toujours déclaré : `'unknown'` est une valeur du vocabulaire, pas une absence.
  // C'est la seule capability dont la présence ne dépend pas de ce que l'appareil a répondu.
  declare('ups_status', snapshot.status);

  // Nommer ce qui ne va pas. Les quatre alarmes booléennes déclenchent les Flows ; ce
  // texte dit **quoi**, et c'est la seule chose qui distingue un ventilateur en panne
  // d'un chargeur qui a lâché. Déclarée seulement quand il y a quelque chose à dire :
  // un champ vide en permanence sur un onduleur sain n'apprend rien à personne.
  if (snapshot.alarmSummary !== null) declare('ups_alarm_text', snapshot.alarmSummary);

  for (const rule of MEASURES) {
    const value = rule.read(snapshot);
    if (value === null) {
      omitted.push({ id: rule.id, reason: 'no-value' });
      continue;
    }
    declare(rule.id, value);
    if (rule.title) options.set(rule.id, { title: rule.title });
  }

  const support = ALARM_SUPPORT[snapshot.source];
  for (const { id, flag } of ALARMS) {
    if (!support[flag]) {
      omitted.push({ id, reason: 'unsupported-by-source' });
      continue;
    }
    declare(id, snapshot.alarms[flag]);
  }

  const needsEnergy = BATTERY_CAPABILITIES.some((id) => capabilities.includes(id));

  return {
    capabilities,
    values,
    options,
    energy: needsEnergy ? { batteries: ['INTERNAL'] } : null,
    omitted,
  };
}

/**
 * Les valeurs à écrire sur un appareil **déjà** appairé, pour l'ensemble de capabilities
 * qu'il porte réellement.
 *
 * Distinct de {@link planCapabilities} parce que les deux questions sont distinctes :
 * *quoi déclarer* se décide une fois, sur ce que l'appareil a su donner ; *quoi écrire* se
 * rejoue à chaque cycle. Une capability déclarée dont la mesure disparaît reçoit `null` —
 * « on ne sait plus » — et surtout **pas** `0`, qui serait lu comme une batterie vide.
 *
 * Une capability inconnue de cette table est ignorée sans erreur : elle a pu être posée par
 * une version antérieure de l'app, et on ne la retire pas (cf. {@link reconcileCapabilities}).
 */
export function capabilityValues(
  snapshot: UpsSnapshot,
  declared: readonly string[],
): CapabilityValue[] {
  const out: CapabilityValue[] = [];
  const support = ALARM_SUPPORT[snapshot.source];

  for (const id of declared) {
    if (id === 'ups_status') {
      out.push({ id, value: snapshot.status });
      continue;
    }
    // 🔴 Cette capability manquait ici, et le manque ne se voyait pas : une fois déclarée
    // — ce qui n'arrive qu'à la première alarme — elle n'était **plus jamais réécrite**.
    // Elle restait donc figée sur l'alarme du jour où elle est apparue, ou vide quand
    // l'alarme s'était déjà dissipée au moment de la synchronisation. Signalé depuis une
    // vraie installation : « an additional capability, with no value: Alarm ».
    //
    // Un texte d'alarme périmé est pire qu'aucun : il décrit un incident passé avec
    // l'autorité du présent. Il est donc réécrit à chaque cycle, `null` compris — le
    // device traduit cette absence en « rien à signaler », car lui seul connaît la langue.
    if (id === 'ups_alarm_text') {
      out.push({ id, value: snapshot.alarmSummary });
      continue;
    }
    const measure = MEASURES.find((rule) => rule.id === id);
    if (measure) {
      out.push({ id, value: measure.read(snapshot) });
      continue;
    }
    const alarm = ALARMS.find((rule) => rule.id === id);
    if (alarm) {
      // La source a pu changer depuis le pairing (un NAS remplacé par une carte réseau) :
      // une alarme que le dialecte courant n'expose pas devient inconnue, jamais `false`.
      out.push({ id, value: support[alarm.flag] ? snapshot.alarms[alarm.flag] : null });
    }
  }

  return out;
}

/** Ce que l'appareil doit ajouter, et ce qu'il porte en trop — sans jamais rien retirer. */
export interface CapabilityReconciliation {
  /** À ajouter par `addCapability`, dans l'ordre du plan. */
  toAdd: string[];
  /**
   * Portées par l'appareil mais absentes du plan courant : une mesure que l'onduleur ne
   * rend plus, ou une capability d'une version antérieure.
   *
   * 🔴 **À signaler, jamais à retirer.** `removeCapability` détruit l'historique Insights
   * de façon irréversible, et une mesure absente d'un seul cycle n'est pas une mesure
   * disparue. Il n'existe volontairement aucun `toRemove` dans ce type.
   */
  orphaned: string[];
}

/** Compare les capabilities portées par l'appareil au plan courant. */
export function reconcileCapabilities(
  existing: readonly string[],
  planned: readonly string[],
): CapabilityReconciliation {
  const have = new Set(existing);
  const want = new Set(planned);
  return {
    toAdd: planned.filter((id) => !have.has(id)),
    orphaned: existing.filter((id) => !want.has(id)),
  };
}
