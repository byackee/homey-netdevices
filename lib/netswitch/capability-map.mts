/**
 * D'un port au plan de capabilities Homey.
 *
 * **Aucun import Homey.** Même motif que `lib/ups/capability-map.mts`, et pour la même
 * raison : c'est ici que se décide ce que l'utilisateur voit, et rien de ce qui se décide
 * ici n'a besoin d'une app qui tourne pour être vérifié.
 *
 * Quatre décisions portent le reste :
 *
 * 1. 🔴 **Une capability sans valeur n'est pas déclarée.** `removeCapability` détruit
 *    l'historique Insights de façon irréversible : ce qui n'est pas déclaré au pairing ne
 *    coûte rien, ce qui est déclaré à tort coûte pour toujours.
 * 2. 🔴 **Les débits se déclarent sur la présence du compteur, pas sur celle du débit.**
 *    Au premier relevé, `ifHCInOctets` répond mais `rxMbps` vaut encore `null` — il faut
 *    deux échantillons pour une différence. Décider sur `rxMbps` reviendrait à ne jamais
 *    déclarer le débit, et le port publierait un compteur d'octets que personne ne lit.
 *    C'est la jointure exacte que la revue a trouvée ailleurs : une mesure calculée, puis
 *    jetée, sans un mot.
 * 3. 🔴 **`onoff` n'existe que si l'écriture est activée.** Tant que le réglage
 *    `allow_control` est faux, la capability n'est pas déclarée — donc Homey ne génère
 *    aucune carte de Flow qui l'utilise, et aucun chemin ne peut émettre de SET.
 * 4. **`null` reste `null`.** Un port illisible n'est pas un port à zéro erreur.
 */

import type { CapabilityOptions, CapabilityValue, LocalisedTitle } from '../ups/capability-map.mjs';
import type { SyncablePlan } from '../ups/capability-sync.mjs';
import type { LinkState } from './if-mib.mjs';
import type { PoeStatus } from './poe-mib.mjs';
import type { PortSnapshot } from './port.mjs';

export type { CapabilityValue };

/** Ce que le device sait de son propre droit d'écriture au moment du plan. */
export interface PortPlanOptions {
  /** Le réglage `allow_control`. Faux par défaut, et faux tant que rien ne l'a changé. */
  allowControl: boolean;
}

/** Le plan d'un port : ce que `syncCapabilities` attend, plus ce qu'on écarte et pourquoi. */
export interface PortCapabilityPlan extends SyncablePlan {
  values: CapabilityValue[];
  omitted: { id: string; reason: 'no-value' | 'control-disabled' }[];
}

/**
 * Le vocabulaire de `netswitch_link`, dérivé du type et non recopié.
 *
 * Le `Record<LinkState, true>` est un garde-fou de compilation : si une valeur apparaît
 * dans `LinkState`, ce fichier cesse de compiler au lieu de laisser une valeur absente de
 * l'énumération déclarée à Homey — auquel cas `setCapabilityValue` la refuserait en
 * silence, à l'exécution, sur du vrai matériel.
 */
const LINK_DECLARED: Record<LinkState, true> = {
  up: true,
  down: true,
  testing: true,
  unknown: true,
  dormant: true,
  notPresent: true,
  lowerLayerDown: true,
};

export const LINK_VALUES = Object.keys(LINK_DECLARED) as LinkState[];

/** Même garde-fou pour `netswitch_poe`. */
const POE_DECLARED: Record<PoeStatus, true> = {
  disabled: true,
  searching: true,
  delivering: true,
  fault: true,
  test: true,
  otherFault: true,
  unknown: true,
};

export const POE_VALUES = Object.keys(POE_DECLARED) as PoeStatus[];

/** Une mesure numérique : ce qui la déclare, et ce qui l'alimente. */
interface MeasureRule {
  id: string;
  /**
   * Ce dont la **présence** décide de la déclaration.
   *
   * Distinct de `read` pour les débits, et c'est tout l'objet de la décision 2 de
   * l'en-tête. Pour les autres mesures, les deux fonctions lisent le même champ.
   */
  declaredBy: (port: PortSnapshot) => number | null;
  read: (port: PortSnapshot) => number | null;
  title?: LocalisedTitle;
}

const MEASURES: readonly MeasureRule[] = [
  {
    id: 'netswitch_speed',
    declaredBy: (p) => p.speedMbps,
    read: (p) => p.speedMbps,
  },
  {
    id: 'netswitch_rx',
    // 🔴 Le compteur décide, le débit alimente. Voir la décision 2.
    declaredBy: (p) => p.octetsIn,
    read: (p) => p.rxMbps,
  },
  {
    id: 'netswitch_tx',
    declaredBy: (p) => p.octetsOut,
    read: (p) => p.txMbps,
  },
  {
    id: 'netswitch_errors_in',
    declaredBy: (p) => p.errorsIn,
    read: (p) => p.errorsIn,
  },
  {
    id: 'netswitch_errors_out',
    declaredBy: (p) => p.errorsOut,
    read: (p) => p.errorsOut,
  },
  {
    id: 'netswitch_poe_power',
    declaredBy: (p) => p.poe?.groupPowerWatts ?? null,
    read: (p) => p.poe?.groupPowerWatts ?? null,
  },
];

/**
 * Bâtit le plan d'un port.
 *
 * À appeler au pairing sur un cycle complet, **et** à chaque changement du réglage
 * `allow_control` : c'est le seul réglage qui ajoute une capability après coup.
 * `syncCapabilities` étant idempotent, l'appeler à chaque relevé ne coûte rien non plus.
 */
export function planPortCapabilities(
  port: PortSnapshot,
  options: PortPlanOptions,
): PortCapabilityPlan {
  const capabilities: string[] = [];
  const values: CapabilityValue[] = [];
  const omitted: PortCapabilityPlan['omitted'] = [];
  const capabilityOptions = new Map<string, CapabilityOptions>();

  const declare = (id: string, value: CapabilityValue['value']): void => {
    capabilities.push(id);
    values.push({ id, value });
  };

  // 🔴 `onoff` en premier : Homey met la commande en tête de la fiche d'appareil, et
  // c'est aussi l'ordre dans lequel on veut la lire ici — ce qui agit avant ce qui mesure.
  if (options.allowControl) declare('onoff', port.adminUp);
  else omitted.push({ id: 'onoff', reason: 'control-disabled' });

  // L'état du lien est toujours déclaré : `'unknown'` est une valeur du vocabulaire, pas
  // une absence. C'est la seule capability qui ne dépend pas de ce que le port a répondu.
  declare('netswitch_link', port.link);

  if (port.poe !== null) declare('netswitch_poe', port.poe.status);
  else omitted.push({ id: 'netswitch_poe', reason: 'no-value' });

  for (const rule of MEASURES) {
    if (rule.declaredBy(port) === null) {
      omitted.push({ id: rule.id, reason: 'no-value' });
      continue;
    }
    declare(rule.id, rule.read(port));
    if (rule.title) capabilityOptions.set(rule.id, { title: rule.title });
  }

  return {
    capabilities,
    values,
    options: capabilityOptions,
    // Un port de switch n'a pas de batterie : poser `energy.batteries` mentirait à Homey
    // sur la nature de l'appareil, et cette clé n'a pas de retour en arrière propre.
    energy: null,
    omitted,
  };
}

/**
 * Les valeurs à écrire sur un port **déjà** appairé, pour les capabilities qu'il porte.
 *
 * Distinct du plan parce que les deux questions le sont : *quoi déclarer* se décide une
 * fois, *quoi écrire* se rejoue à chaque relevé. Une capability déclarée dont la mesure
 * disparaît reçoit `null` — « on ne sait plus » — jamais `0`, qui se lirait comme un lien
 * à l'arrêt ou un port sans trafic.
 *
 * Une capability inconnue de cette table est ignorée sans erreur : elle a pu être posée
 * par une version antérieure de l'app, et on ne retire jamais rien.
 */
export function portCapabilityValues(
  port: PortSnapshot,
  declared: readonly string[],
): CapabilityValue[] {
  const out: CapabilityValue[] = [];

  for (const id of declared) {
    if (id === 'netswitch_link') {
      out.push({ id, value: port.link });
      continue;
    }
    if (id === 'netswitch_poe') {
      // La correspondance PoE peut se perdre — un module retiré, une renumérotation.
      // Elle devient alors inconnue, et surtout pas `disabled`, qui serait une affirmation.
      out.push({ id, value: port.poe === null ? null : port.poe.status });
      continue;
    }
    if (id === 'onoff') {
      out.push({ id, value: port.adminUp });
      continue;
    }
    const measure = MEASURES.find((rule) => rule.id === id);
    if (measure) out.push({ id, value: measure.read(port) });
  }

  return out;
}
