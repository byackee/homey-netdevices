/**
 * Aligner les capabilities d'un appareil sur ce que sa source sait rendre.
 *
 * Extrait du device pour la même raison que `poll-engine` : `drivers/ups/device.mts`
 * ne peut pas être importé dans un test — le paquet `homey` est la CLI, pas le SDK
 * runtime. Toute logique qui reste dans le device n'est donc vérifiable que sur un vrai
 * Homey, et c'est exactement là que les trois apps précédentes se sont fait piéger.
 *
 * Ici, les effets passent par {@link CapabilitySink}, qu'un double de test satisfait en
 * quelques lignes. Le device se contente de brancher `this` dessus.
 */

import { planCapabilities, reconcileCapabilities, type CapabilityOptions } from './capability-map.mjs';
import type { UpsSnapshot } from './snapshot.mjs';

/** Les seuls effets Homey dont l'alignement a besoin. */
export interface CapabilitySink {
  listCapabilities(): readonly string[];
  addCapability(id: string): Promise<void>;
  setCapabilityOptions(id: string, options: CapabilityOptions): Promise<void>;
  setEnergy(energy: { batteries: string[] }): Promise<void>;
  log(message: string): void;
  error(message: string): void;
}

/** Ce que l'alignement a fait, pour que l'appelant puisse le journaliser ou l'épingler. */
export interface CapabilitySyncResult {
  added: string[];
  /** Déclarées mais sans source : **conservées**, jamais retirées. */
  orphaned: string[];
  /** L'alignement a-t-il écrit quoi que ce soit ? */
  changed: boolean;
}

/**
 * Ajoute ce qui manque, ne retire jamais rien.
 *
 * `removeCapability` détruit l'historique Insights de façon irréversible. Une capability
 * qu'un onduleur cesse de publier — parce qu'il dort, ou répond partiellement — coûterait
 * des mois de courbes. `reconcileCapabilities` n'expose délibérément aucun `toRemove`.
 *
 * **Idempotent** : quand le plan est déjà satisfait, rien n'est écrit. C'est ce qui rend
 * l'appel acceptable dans une boucle à dix secondes, où toute écriture persistante par
 * tick serait un défaut en soi.
 */
export async function syncCapabilities(
  snapshot: UpsSnapshot,
  sink: CapabilitySink,
): Promise<CapabilitySyncResult> {
  const plan = planCapabilities(snapshot);
  const { toAdd, orphaned } = reconcileCapabilities(sink.listCapabilities(), plan.capabilities);

  if (toAdd.length === 0) return { added: [], orphaned, changed: false };

  sink.log(`Cet onduleur publie ${toAdd.length} mesure(s) de plus : ${toAdd.join(', ')}`);

  const added: string[] = [];
  for (const id of toAdd) {
    try {
      await sink.addCapability(id);
      added.push(id);
    } catch (error) {
      sink.error(`Impossible d'ajouter ${id} : ${(error as Error).message}`);
    }
  }

  // Les titres viennent après l'ajout : Homey n'accepte d'options que sur une capability
  // qui existe. Et il n'en génère aucun pour les sous-capabilities, si bien que sans eux
  // les trois tensions s'afficheraient toutes « Voltage ».
  for (const [id, options] of plan.options) {
    if (!added.includes(id) && !sink.listCapabilities().includes(id)) continue;
    await sink.setCapabilityOptions(id, options).catch((error: Error) =>
      sink.error(`Impossible de titrer ${id} : ${error.message}`));
  }

  if (plan.energy) {
    // Obligatoire dès que `measure_battery` ou `alarm_battery` est déclarée. Légitime
    // ici : la batterie est bien dans l'appareil, d'où `INTERNAL`.
    await sink.setEnergy(plan.energy).catch((error: Error) =>
      sink.error(`Impossible de déclarer la batterie : ${error.message}`));
  }

  return { added, orphaned, changed: added.length > 0 };
}
