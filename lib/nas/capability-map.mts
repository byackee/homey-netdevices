/**
 * Du snapshot d'hôte au plan de capabilities Homey.
 *
 * **Aucun import Homey.** Toutes les règles qui décident de ce que l'utilisateur voit
 * vivent ici, et aucune n'a besoin d'une app qui tourne — c'est le motif de
 * `lib/ups/capability-map.mts`, et c'est ce qui rend ces règles testables.
 *
 * Trois décisions portent tout le reste :
 *
 * 1. 🔴 **Une capability sans valeur n'est pas déclarée.** Jamais posée à `null` pour
 *    être retirée plus tard : `removeCapability` détruit l'historique Insights de façon
 *    irréversible. Le tri se fait au pairing, sur ce que l'hôte a réellement su rendre,
 *    et `reconcileCapabilities` n'a délibérément aucun chemin de retrait.
 * 2. 🔴 **`null` veut dire « on ne sait pas » et se propage jusqu'ici.** Un volume à 0 %
 *    est un volume vide ; un volume dont la taille n'a pas pu être lue est `null`. Une
 *    charge CPU absente ne devient jamais 0 %, qui se lirait comme une machine au repos.
 * 3. 🔴 **Un volume démonté garde sa capability, et reçoit `null`.** Il n'est pas retiré,
 *    et il n'est surtout pas laissé sur sa dernière valeur : une courbe plate à 71 %
 *    pendant trois semaines ressemble à un volume tranquille, pas à un volume absent.
 *
 * ## Pourquoi les volumes sont des sous-capabilities
 *
 * `nas_storage_used.volume1`, `nas_storage_used.volume2` — et non une capability par
 * volume, ni un seul chiffre agrégé. Un NAS a un nombre de volumes qu'on ne connaît qu'au
 * pairing, ce qui exclut de les déclarer d'avance ; et « 68 % de remplissage » tous
 * volumes confondus ne veut rien dire quand le volume système est plein et le volume de
 * données vide.
 *
 * ⚠️ Homey ne génère **aucun** titre pour une sous-capability : sans les
 * `capabilitiesOptions` posées ici, les quatre volumes s'afficheraient tous « Storage
 * used ». C'est la même mécanique que les trois tensions de l'onduleur, et le même piège.
 */

import type { CapabilityOptions, LocalisedTitle } from '../ups/capability-map.mjs';
import type { NasSnapshot, NasVolume } from './snapshot.mjs';

export type { CapabilityOptions, LocalisedTitle };

/** Une capability et la valeur à y écrire. `null` = « on ne sait pas », rendu inconnu par Homey. */
export interface CapabilityValue {
  id: string;
  value: number | string | boolean | null;
}

/** Pourquoi une capability candidate n'a pas été déclarée. Diagnostic, pas logique. */
export interface OmittedCapability {
  id: string;
  /** `no-value` : l'hôte n'a rien rendu sur cette mesure. */
  reason: 'no-value';
}

/** Le résultat du mapping d'un snapshot. */
export interface NasCapabilityPlan {
  /** Toutes les capabilities que cet hôte doit porter, dans l'ordre d'affichage. */
  capabilities: string[];
  /** Les valeurs à écrire, une par entrée de {@link capabilities}, dans le même ordre. */
  values: CapabilityValue[];
  /** Les `capabilitiesOptions` à poser — les titres des volumes, que Homey ne génère pas. */
  options: Map<string, CapabilityOptions>;
  /**
   * Toujours `null` pour un hôte.
   *
   * Le champ existe parce que `syncCapabilities` prend un `SyncablePlan` générique et
   * qu'il vaut `{ batteries: [...] }` côté onduleur. Ici, aucune capability de batterie
   * n'est déclarée : poser `energy` reviendrait à affirmer qu'un NAS est sur batterie,
   * ce qui déplacerait sa consommation dans le mauvais bilan énergétique de Homey.
   */
  energy: null;
  /** Les capabilities candidates écartées, avec la raison. */
  omitted: OmittedCapability[];
}

/** Le préfixe des sous-capabilities de volume. Un seul endroit le connaît. */
export const STORAGE_CAPABILITY = 'nas_storage_used';

/** L'identifiant complet de la sous-capability d'un volume. */
export function storageCapabilityId(key: string): string {
  return `${STORAGE_CAPABILITY}.${key}`;
}

/** La clé de volume portée par une sous-capability, ou `null` si ce n'en est pas une. */
export function volumeKeyOf(capabilityId: string): string | null {
  const prefix = `${STORAGE_CAPABILITY}.`;
  return capabilityId.startsWith(prefix) ? capabilityId.slice(prefix.length) : null;
}

/** Une mesure scalaire : son id de capability et le champ du snapshot qui la porte. */
interface MeasureRule {
  id: string;
  read: (snapshot: NasSnapshot) => number | null;
}

/**
 * Les mesures scalaires, dans l'ordre d'affichage.
 *
 * L'ordre est celui de l'intérêt décroissant sur une tuile de téléphone : ce qui bouge
 * et qui inquiète d'abord — la charge, la mémoire, la température — et l'uptime en
 * dernier, qui est une information de confort.
 */
const MEASURES: readonly MeasureRule[] = [
  { id: 'nas_cpu_load', read: (s) => s.cpuLoad },
  { id: 'nas_memory_used', read: (s) => s.memoryUsedPercent },
  { id: 'measure_temperature', read: (s) => s.temperature },
  { id: 'nas_uptime', read: (s) => s.uptimeDays },
];

/**
 * Le titre d'un volume : son point de montage, tel quel, dans les trois langues.
 *
 * Il n'y a rien à traduire dans « /volume1 » ou « C:\ », et surtout rien à embellir : le
 * point de montage est ce que l'utilisateur voit dans DSM, dans son terminal et dans son
 * explorateur. Une paraphrase — « Volume principal » — le forcerait à deviner de quel
 * volume on parle.
 */
export function volumeTitle(volume: NasVolume): LocalisedTitle {
  return { en: volume.label, fr: volume.label, nl: volume.label };
}

/**
 * Bâtit le plan de capabilities d'un snapshot.
 *
 * À appeler **au pairing**, sur un cycle complet : ce qui est décidé ici est définitif
 * pour la vie de l'appareil. Un snapshot partiel — un `readLive()` seul, dont les volumes
 * sont vides par construction — priverait l'utilisateur de tous ses disques, sans retour
 * possible.
 */
export function planNasCapabilities(snapshot: NasSnapshot): NasCapabilityPlan {
  const capabilities: string[] = [];
  const values: CapabilityValue[] = [];
  const options = new Map<string, CapabilityOptions>();
  const omitted: OmittedCapability[] = [];

  const declare = (id: string, value: CapabilityValue['value']): void => {
    capabilities.push(id);
    values.push({ id, value });
  };

  for (const rule of MEASURES) {
    const value = rule.read(snapshot);
    if (value === null) {
      omitted.push({ id: rule.id, reason: 'no-value' });
      continue;
    }
    declare(rule.id, value);
  }

  for (const volume of snapshot.volumes) {
    const id = storageCapabilityId(volume.key);
    if (volume.usedPercent === null) {
      omitted.push({ id, reason: 'no-value' });
      continue;
    }
    declare(id, volume.usedPercent);
    // Sans ce titre, tous les volumes s'afficheraient sous le même libellé générique :
    // Homey n'en génère aucun pour une sous-capability.
    options.set(id, { title: volumeTitle(volume) });
  }

  return { capabilities, values, options, energy: null, omitted };
}

/**
 * Les valeurs à écrire sur un appareil **déjà** appairé, pour l'ensemble de capabilities
 * qu'il porte réellement.
 *
 * Distinct de {@link planNasCapabilities} parce que les deux questions le sont : *quoi
 * déclarer* se décide une fois, sur ce que l'hôte a su donner ; *quoi écrire* se rejoue à
 * chaque cycle.
 *
 * 🔴 Un volume déclaré qui a disparu de `hrStorageTable` — démonté, en panne, ou dont
 * l'agent a cessé de le publier — reçoit `null`. Pas `0` (un disque vide), pas sa
 * dernière valeur (une courbe plate qui ment). Une capability inconnue de cette table est
 * ignorée sans erreur : elle a pu être posée par une version antérieure de l'app, et on
 * ne la retire pas.
 */
export function nasCapabilityValues(
  snapshot: NasSnapshot,
  declared: readonly string[],
): CapabilityValue[] {
  const byKey = new Map(snapshot.volumes.map((volume) => [volume.key, volume]));
  const out: CapabilityValue[] = [];

  for (const id of declared) {
    const measure = MEASURES.find((rule) => rule.id === id);
    if (measure) {
      out.push({ id, value: measure.read(snapshot) });
      continue;
    }

    const key = volumeKeyOf(id);
    if (key !== null) out.push({ id, value: byKey.get(key)?.usedPercent ?? null });
  }

  return out;
}
