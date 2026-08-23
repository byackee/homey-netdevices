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

const LABEL: Record<Rfc1628Alarm, LocalisedText> = {
  shutdownImminent: { en: 'shutdown imminent', fr: 'arrêt imminent', nl: 'uitschakeling ophanden' },
  upsSystemOff: { en: 'UPS switched off', fr: 'onduleur éteint', nl: 'UPS uitgeschakeld' },
  upsOutputOff: { en: 'output switched off', fr: 'sortie coupée', nl: 'uitgang uitgeschakeld' },
  depletedBattery: { en: 'battery depleted', fr: 'batterie épuisée', nl: 'accu leeg' },
  shutdownPending: { en: 'shutdown scheduled', fr: 'arrêt programmé', nl: 'uitschakeling gepland' },
  onBypass: { en: 'on bypass, load unprotected', fr: 'sur bypass, charge non protégée', nl: 'op bypass, belasting onbeschermd' },
  bypassBad: { en: 'bypass faulty', fr: 'bypass en défaut', nl: 'bypass defect' },
  outputBad: { en: 'output out of tolerance', fr: 'sortie hors tolérance', nl: 'uitgang buiten tolerantie' },
  outputOverload: { en: 'output overloaded', fr: 'surcharge en sortie', nl: 'uitgang overbelast' },
  generalFault: { en: 'general fault', fr: 'défaut général', nl: 'algemene storing' },
  fanFailure: { en: 'fan failed', fr: 'ventilateur en panne', nl: 'ventilator defect' },
  fuseFailure: { en: 'fuse blown', fr: 'fusible en défaut', nl: 'zekering defect' },
  chargerFailed: { en: 'charger failed', fr: 'chargeur en panne', nl: 'lader defect' },
  batteryBad: { en: 'battery needs replacing', fr: 'batterie à remplacer', nl: 'accu moet vervangen worden' },
  tempBad: { en: 'temperature out of range', fr: 'température anormale', nl: 'temperatuur buiten bereik' },
  lowBattery: { en: 'battery low', fr: 'batterie faible', nl: 'accu bijna leeg' },
  onBattery: { en: 'on battery', fr: 'sur batterie', nl: 'op accu' },
  inputBad: { en: 'mains out of tolerance', fr: 'secteur hors tolérance', nl: 'netspanning buiten tolerantie' },
  awaitingPower: { en: 'waiting for mains', fr: 'en attente du secteur', nl: 'wacht op netspanning' },
  communicationsLost: { en: 'communication lost', fr: 'dialogue interrompu', nl: 'communicatie verbroken' },
  diagnosticTestFailed: { en: 'self-test failed', fr: 'test de diagnostic échoué', nl: 'zelftest mislukt' },
  testInProgress: { en: 'self-test running', fr: 'test en cours', nl: 'zelftest bezig' },
  outputOffAsRequested: { en: 'output switched off on request', fr: 'sortie coupée à la demande', nl: 'uitgang uitgeschakeld op verzoek' },
  upsOffAsRequested: { en: 'UPS switched off on request', fr: 'onduleur éteint à la demande', nl: 'UPS uitgeschakeld op verzoek' },
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
const NUT_LABEL: Record<string, LocalisedText> = {
  BYPASS: { en: 'on bypass, load unprotected', fr: 'sur bypass, charge non protégée', nl: 'op bypass, belasting onbeschermd' },
  OFF: { en: 'UPS switched off', fr: 'onduleur éteint', nl: 'UPS uitgeschakeld' },
  FSD: { en: 'forced shutdown requested', fr: 'arrêt forcé demandé', nl: 'geforceerde uitschakeling gevraagd' },
  CAL: { en: 'calibration running', fr: 'calibration en cours', nl: 'kalibratie bezig' },
  HB: { en: 'battery overvoltage', fr: 'batterie en surtension', nl: 'accu-overspanning' },
  TRIM: { en: 'trimming high mains', fr: 'correction de tension haute', nl: 'hoge netspanning gecorrigeerd' },
  BOOST: { en: 'boosting low mains', fr: 'correction de tension basse', nl: 'lage netspanning gecorrigeerd' },
  CHRG: { en: 'battery charging', fr: 'batterie en charge', nl: 'accu wordt geladen' },
};

/** L'ordre d'affichage de ces jetons, du plus alarmant au plus anodin. */
const NUT_ORDER = ['FSD', 'OFF', 'BYPASS', 'HB', 'CAL', 'TRIM', 'BOOST', 'CHRG'];

/**
 * Traduit les jetons NUT porteurs d'information en fragments.
 *
 * Les jetons inconnus remontent **tels quels**, en `raw` : un jeton qu'on ne sait pas
 * traduire reste une information, et le taire serait pire que de l'afficher brut.
 */
export function nutFlagParts(flags: readonly string[], unknown: readonly string[] = []): AlarmPart[] {
  const known: AlarmPart[] = NUT_ORDER
    .filter((flag) => flags.includes(flag))
    .map((flag) => ({ kind: 'named', text: NUT_LABEL[flag]! }));
  return [...known, ...unknown.map((text): AlarmPart => ({ kind: 'raw', text }))];
}

/**
 * Un texte dans les trois langues de l'app. Même forme que ce qu'attend `homey.__()`.
 *
 * 🔴 Ces libellés étaient écrits **en français en dur** dans une app publiée en anglais,
 * en français et en néerlandais. Un utilisateur anglophone lisait « ventilateur en panne »
 * — et il le lisait au moment précis où la clarté compte le plus, son onduleur étant en
 * défaut. Le compilateur ne pouvait rien en dire : une chaîne est une chaîne.
 */
export interface LocalisedText {
  en: string;
  fr: string;
  nl: string;
}

/**
 * Un fragment de résumé, **avant** traduction.
 *
 * C'est la frontière : `lib/` sait ce qui ne va pas, il ne sait pas dans quelle langue
 * le dire. Seul le device connaît la langue de l'utilisateur, et c'est donc lui qui rend
 * la phrase — d'où une structure ici plutôt qu'un texte.
 */
export type AlarmPart =
  /** Une alarme reconnue, traduisible. */
  | { kind: 'named'; text: LocalisedText }
  /**
   * Ce que l'agent a dit, mot pour mot.
   *
   * Ni traduit ni interprété : un firmware qui écrit « Battery needs service » dit quelque
   * chose que l'app ne sait pas nommer, et le réécrire reviendrait à inventer.
   */
  | { kind: 'raw'; text: string }
  /** Des alarmes que l'app ne sait pas nommer, mais qui existent. */
  | { kind: 'foreign'; count: number };

/** Ce qui ne va pas, nommé mais pas encore dit. `null` quand il n'y a rien à signaler. */
export interface AlarmSummary {
  /** Du plus grave au plus anodin. */
  parts: AlarmPart[];
  /** L'agent annonce plus d'alarmes que la fenêtre sondée n'en couvre. */
  truncated: boolean;
}

export interface AlarmSummaryInput {
  /** Alarmes RFC reconnues. */
  named?: readonly Rfc1628Alarm[];
  /** Fragments déjà construits — les jetons NUT, via {@link nutFlagParts}. */
  parts?: readonly AlarmPart[];
  /** Textes libres de l'agent, repris mot pour mot. */
  texts?: readonly (string | null | undefined)[];
  /** Nombre d'OID d'alarme non reconnus : une MIB constructeur qu'on ne sait pas lire. */
  foreign?: number;
  /** L'agent annonce plus d'alarmes que la fenêtre sondée n'en couvre. */
  truncated?: boolean;
}

/**
 * Rassemble ce qui ne va pas, **sans le dire**.
 *
 * Rend `null` quand il n'y a rien à signaler — et pas une structure vide : c'est cette
 * absence qui décide qu'aucune capability de texte d'alarme n'est déclarée, plutôt que
 * d'afficher un champ vide en permanence sur un onduleur qui va parfaitement bien.
 */
export function alarmParts(input: AlarmSummaryInput): AlarmSummary | null {
  const parts: AlarmPart[] = [];
  const seen = new Set<string>();

  for (const name of [...(input.named ?? [])].sort(
    (a, b) => (RANK.get(a) ?? 99) - (RANK.get(b) ?? 99),
  )) {
    const text = LABEL[name];
    // Une alarme de la RFC qu'on ne saurait pas nommer sortirait sous sa clé technique
    // plutôt que d'être tue — mais la table est close par le type, donc ce cas n'arrive
    // que si quelqu'un ajoute une alarme sans son libellé.
    parts.push(text ? { kind: 'named', text } : { kind: 'raw', text: name });
    if (text) seen.add(text.en);
  }

  for (const part of input.parts ?? []) {
    // Les doublons se jugent sur l'anglais : la même alarme peut venir de deux sources —
    // un jeton NUT et un bit de la RFC — et l'afficher deux fois ferait douter du reste.
    const key = part.kind === 'named' ? part.text.en : part.kind === 'raw' ? part.text : '';
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }

  for (const text of input.texts ?? []) {
    const trimmed = (text ?? '').trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push({ kind: 'raw', text: trimmed });
  }

  // Une alarme qu'on ne sait pas nommer reste une alarme : la taire serait pire que
  // de l'annoncer sans son nom.
  const unnamed = input.foreign ?? 0;
  if (unnamed > 0) parts.push({ kind: 'foreign', count: unnamed });

  const truncated = input.truncated === true;
  if (parts.length === 0 && !truncated) return null;
  return { parts, truncated };
}

/** Ce que l'appelant doit fournir pour traduire : la signature de `homey.__()`. */
export type Translate = (text: LocalisedText) => string;

/**
 * Rend le résumé dans **une** langue.
 *
 * La troncature a lieu ici et pas dans {@link alarmParts}, parce qu'elle dépend de la
 * longueur des mots : « uitschakeling ophanden » et « shutdown imminent » ne coupent pas
 * au même endroit. Couper en amont donnerait une phrase française bien calibrée et une
 * phrase néerlandaise tronquée au milieu d'un mot.
 */
export function renderAlarmSummary(summary: AlarmSummary, t: Translate): string {
  const rendered = summary.parts.map((part) => {
    if (part.kind === 'named') return t(part.text);
    if (part.kind === 'raw') return part.text;
    return part.count === 1
      ? t({ en: '1 vendor alarm', fr: '1 alarme constructeur', nl: '1 fabrikantalarm' })
      : t({
        en: `${part.count} vendor alarms`,
        fr: `${part.count} alarmes constructeur`,
        nl: `${part.count} fabrikantalarmen`,
      });
  });

  const kept = rendered.slice(0, MAX_ENTRIES);
  const dropped = rendered.length - kept.length + (summary.truncated ? 1 : 0);
  if (dropped > 0) {
    kept.push(dropped === 1
      ? t({ en: '+1 more', fr: '+1 autre', nl: '+1 andere' })
      : t({ en: `+${dropped} more`, fr: `+${dropped} autres`, nl: `+${dropped} andere` }));
  }

  const text = kept.join(' · ');
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1).trimEnd()}…` : text;
}
