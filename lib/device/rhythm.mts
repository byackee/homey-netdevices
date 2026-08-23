/**
 * Les rythmes de relevé et la garde de réentrance, communs à toutes les classes.
 *
 * Extraits de `drivers/ups/poll-engine.mts` au moment d'ajouter les drivers NAS et
 * switch : rien là-dedans ne sait ce qu'est un onduleur, et le recopier dans chaque
 * driver aurait garanti qu'un correctif n'atteigne jamais les trois.
 *
 * Ce qui reste dans le driver onduleur, c'est ce qui lui appartient vraiment : le gel
 * pendant une coupure de courant, qui n'a pas de sens pour un NAS ou un switch.
 */

export const FAILURES_BEFORE_VERDICT = 3;

/**
 * Les deux rythmes du §3.4, avec des planchers **différents**.
 *
 * Le plancher rapide est bas parce qu'un passage sur batterie se mesure en secondes ;
 * le plancher lent est haut parce que relire les tensions et l'identité toutes les
 * dix secondes n'apprend rien et martèle une carte réseau d'onduleur, dont certains
 * firmwares brident les requêtes.
 *
 * Les quatre valeurs sont deux à deux distinctes **à dessein** : un test qui les
 * confond — ou un refactor qui partage un plancher entre les deux groupes — se voit.
 */
export const LIVE_RHYTHM = { defaultSeconds: 10, minSeconds: 5, maxSeconds: 3_600 } as const;
export const DETAIL_RHYTHM = { defaultSeconds: 300, minSeconds: 60, maxSeconds: 86_400 } as const;

export interface Rhythm {
  readonly defaultSeconds: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/**
 * Traduit un réglage utilisateur en millisecondes.
 *
 * Un réglage absent, vide, non numérique ou aberrant retombe sur le défaut plutôt que
 * sur `NaN` : `setTimeout(NaN)` tire immédiatement et en boucle, ce qui transforme un
 * réglage mal saisi en tempête de requêtes SNMP.
 */
export function intervalMs(setting: unknown, rhythm: Rhythm): number {
  const asked = Number(setting);
  const seconds = Number.isFinite(asked) && asked > 0 ? asked : rhythm.defaultSeconds;
  return Math.min(rhythm.maxSeconds, Math.max(rhythm.minSeconds, seconds)) * 1_000;
}

/**
 * Interdit à deux exécutions du même groupe de se chevaucher.
 *
 * Sans elle, un onduleur lent au rythme de 10 s empile les relevés derrière lui-même :
 * chaque tick ouvre un socket de plus, et le compteur d'échecs se met à compter des
 * tentatives concurrentes au lieu de tentatives successives.
 *
 * Une garde **par groupe** : un relevé lent en cours ne doit jamais retarder le relevé
 * rapide, qui est celui qui porte la valeur du produit.
 */
export class PollGate {
  private busy = false;

  /** Rend `false` si l'exécution a été sautée parce que la précédente courait encore. */
  async run(job: () => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await job();
    } finally {
      this.busy = false;
    }
    return true;
  }

  get running(): boolean {
    return this.busy;
  }
}

/** Ce que l'appareil doit devenir aux yeux de Homey. */
