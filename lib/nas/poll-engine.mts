/**
 * La mécanique du device NAS, **sans une seule ligne de Homey**.
 *
 * Tout ce qui décide quelque chose vit ici : les deux rythmes, l'escalade des échecs et
 * la détection de changement qui arme les Flow cards. `drivers/nas/device.mts` au-dessus
 * n'est qu'un adaptateur — il branche des timers Homey sur ces décisions et écrit des
 * capabilities.
 *
 * Ce découpage n'est pas cosmétique : `Homey.Device` ne s'instancie pas hors du runtime
 * Homey, donc rien de ce qui reste dans le device n'est atteignable par un test. C'est
 * exactement là que les trois apps précédentes se sont fait piéger.
 *
 * Le socle générique — `PollGate`, `intervalMs`, `FAILURES_BEFORE_VERDICT` — vient de
 * `lib/device/rhythm.mts` et **n'est pas recopié** : un correctif qui n'atteindrait que
 * l'un des trois drivers ne serait pas un correctif.
 */

import {
  FAILURES_BEFORE_VERDICT,
  PollGate,
  intervalMs,
  type Rhythm,
} from '../device/rhythm.mjs';
import { NAS_LIVE_UNKNOWN, type NasLive, type NasVolume } from './snapshot.mjs';

// Réexportés : le device et les tests les prennent d'ici, comme le fait le driver onduleur.
export { FAILURES_BEFORE_VERDICT, PollGate, intervalMs, type Rhythm };

/**
 * Les deux rythmes de l'hôte, **bien plus lents que ceux de l'onduleur**, et à dessein.
 *
 * Un passage sur batterie se mesure en secondes : c'est ce qui justifie le rythme de dix
 * secondes du driver onduleur. Une charge CPU, non. `hrProcessorLoad` est de toute façon
 * une **moyenne sur la dernière minute** : la relire toutes les dix secondes rendrait six
 * fois la même valeur, en payant six fois le prix — sur la machine même dont on prétend
 * mesurer la charge.
 *
 * Le plancher rapide est à 15 s plutôt qu'à 5 pour la même raison : il n'existe aucun
 * réglage sous lequel un relevé plus fréquent apprenne quoi que ce soit.
 *
 * Le rythme lent est à 15 min parce que c'est le relevé coûteux : deux parcours de table
 * complets, contre un `get` de trois OID pour le rapide. Et ce qu'il lit — la carte des
 * volumes, leur taille — ne bouge pas d'une journée à l'autre.
 *
 * Les quatre valeurs sont deux à deux distinctes à dessein : un test qui les confond, ou
 * un refactor qui partagerait un plancher entre les deux groupes, se voit.
 */
export const NAS_LIVE_RHYTHM: Rhythm = { defaultSeconds: 60, minSeconds: 15, maxSeconds: 3_600 };
export const NAS_DETAIL_RHYTHM: Rhythm = { defaultSeconds: 900, minSeconds: 300, maxSeconds: 86_400 };

/** Ce que l'appareil doit devenir aux yeux de Homey. */
export type Availability = 'available' | 'unavailable';

/**
 * Pourquoi on en est là. Sert au message montré à l'utilisateur et au tampon de traces —
 * `absorbing` et `unreachable` se ressemblent dans les chiffres et se distinguent ici.
 */
export type ContactReason =
  /** Relevé réussi. */
  | 'ok'
  /** Échec, mais sous le seuil : on absorbe sans rien conclure ni rien écrire. */
  | 'absorbing'
  /** Seuil atteint : l'hôte est déclaré injoignable. */
  | 'unreachable';

export interface HostOutcome {
  reason: ContactReason;
  /**
   * Ce qu'il faut publier, ou `null` pour **ne rien écrire**.
   *
   * `null` sous le seuil n'est pas « pas de valeur » : c'est « garde ce qui est
   * affiché ». SNMP est de l'UDP, un datagramme perdu n'est pas une panne, et faire
   * clignoter la tuile à chaque paquet égaré la rendrait illisible.
   */
  live: NasLive | null;
  availability: Availability;
  /** Échecs consécutifs, pour la trace. */
  failures: number;
}

/**
 * Le suivi de contact d'un hôte.
 *
 * 🔴 Volontairement **plus simple que celui de l'onduleur**, et il faut dire pourquoi
 * plutôt que de recopier le sien. Le §3.8 du plan gèle l'état de l'onduleur quand le
 * contact se perd pendant une coupure, parce que le NAS qui relaie l'onduleur est
 * lui-même alimenté par lui : la source disparaît **pendant** l'événement qu'elle sert à
 * détecter, et republier « inconnu » reviendrait à annoncer implicitement que le courant
 * est revenu.
 *
 * Rien de tel ici. Un hôte injoignable n'a pas d'état qu'on trahirait en le lâchant : sa
 * charge CPU d'il y a un quart d'heure ne dit rien de maintenant, et la figer serait un
 * mensonge sans contrepartie. Au seuil, on publie donc {@link NAS_LIVE_UNKNOWN} — toutes
 * les mesures à `null`, jamais à zéro — et on le dit.
 */
export class HostContactTracker {
  private failures = 0;
  private available = true;

  /** Un relevé rapide a réussi. */
  succeeded(live: NasLive): HostOutcome {
    this.failures = 0;
    this.available = true;
    return { reason: 'ok', live, availability: 'available', failures: 0 };
  }

  /** Un relevé rapide a échoué. */
  failed(): HostOutcome {
    this.failures += 1;

    if (this.failures < FAILURES_BEFORE_VERDICT) {
      return {
        reason: 'absorbing',
        live: null,
        availability: this.available ? 'available' : 'unavailable',
        failures: this.failures,
      };
    }

    this.available = false;
    return {
      reason: 'unreachable',
      live: NAS_LIVE_UNKNOWN,
      availability: 'unavailable',
      failures: this.failures,
    };
  }

  /**
   * Remet le compteur à zéro sans rien affirmer, après un changement d'adresse ou de
   * communauté : les échecs d'avant portaient sur une conversation qui n'existe plus.
   *
   * 🔴 `available` repart à `true`, faute de quoi le premier échec sur la **nouvelle**
   * adresse rendrait `availability: 'unavailable'` dès le stade `absorbing` — c'est-à-dire
   * qu'on conclurait à l'injoignabilité du nouvel hôte à partir des échecs de l'ancien.
   * C'est le défaut n°4 de la revue, qui portait sur `reset()` de l'onduleur.
   */
  reset(): void {
    this.failures = 0;
    this.available = true;
  }
}

/** Le franchissement d'un seuil par un volume, tel que la Flow card le reçoit. */
export interface VolumeCrossing {
  key: string;
  label: string;
  before: number | null;
  after: number;
}

/** Les fronts que les Flow cards attendent, calculés par comparaison au relevé précédent. */
export interface NasChangeSet {
  /**
   * L'uptime a **reculé** : la machine a redémarré entre deux relevés.
   *
   * ⚠️ Indiscernable, par construction, du débordement de `hrSystemUptime` à ~497 jours —
   * qui remet le compteur à zéro sans que rien n'ait redémarré. C'est écrit dans le texte
   * de la carte de Flow plutôt que caché : un hôte allumé depuis un an et quatre mois est
   * assez rare pour que la carte reste utile, et assez réel pour qu'on le dise.
   */
  rebooted: boolean;
  uptimeBefore: number | null;
  uptimeAfter: number | null;
}

/**
 * Compare deux relevés rapides successifs.
 *
 * Sur le **tout premier** relevé, `rebooted` ne part pas : il n'y a rien à comparer, et
 * un « votre NAS a redémarré » à chaque redémarrage de l'app Homey serait faux tous les
 * jours sauf un.
 */
export class NasChangeDetector {
  private previous: NasLive | null = null;

  observe(live: NasLive): NasChangeSet {
    const before = this.previous;
    this.previous = live;

    const uptimeBefore = before?.uptimeDays ?? null;
    const uptimeAfter = live.uptimeDays;

    return {
      rebooted: uptimeBefore !== null && uptimeAfter !== null && uptimeAfter < uptimeBefore,
      uptimeBefore,
      uptimeAfter,
    };
  }

  /** Après un changement d'adresse, la comparaison au relevé d'avant n'a plus de sens. */
  reset(): void {
    this.previous = null;
  }
}

/**
 * Suit le remplissage de chaque volume, pour la carte « un volume dépasse X % ».
 *
 * 🔴 Le seuil appartient à **chaque Flow**, pas à l'appareil : deux Flows peuvent vouloir
 * 80 % et 95 %. Le franchissement ne peut donc pas se calculer ici. On expose les deux
 * bornes par volume, et le `runListener` de la carte teste `avant ≤ X < après` — un vrai
 * franchissement, propre à chaque Flow, au lieu d'un déclenchement à chaque relevé passé
 * au-dessus du seuil. C'est la mécanique de `ups_runtime_below`, dans l'autre sens.
 *
 * Un volume qui **apparaît** (premier relevé, ou volume monté depuis) donne
 * `before: null`. {@link NasVolumeDetector.crossedAbove} refuse alors de déclencher : on
 * ne réveille pas quelqu'un à trois heures du matin parce qu'un volume déjà plein depuis
 * six mois vient d'être vu pour la première fois.
 */
export class NasVolumeDetector {
  private previous = new Map<string, number>();

  /** Les volumes dont le remplissage a **augmenté** depuis le relevé précédent. */
  observe(volumes: readonly NasVolume[]): VolumeCrossing[] {
    const crossings: VolumeCrossing[] = [];
    const next = new Map<string, number>();

    for (const volume of volumes) {
      if (volume.usedPercent === null) continue;
      const before = this.previous.get(volume.key) ?? null;
      next.set(volume.key, volume.usedPercent);
      if (before === null || volume.usedPercent <= before) continue;
      crossings.push({ key: volume.key, label: volume.label, before, after: volume.usedPercent });
    }

    // Les volumes absents de ce relevé sortent de la mémoire : un volume démonté puis
    // remonté doit repartir sans « avant », et non se comparer à une valeur d'il y a
    // trois semaines.
    this.previous = next;
    return crossings;
  }

  /**
   * Vrai si le volume **vient de franchir** le seuil vers le haut.
   *
   * Les deux bornes doivent être connues : un `before` à `null` veut dire « on ne sait
   * pas », et on ne déclenche pas sur ce qu'on ne sait pas.
   */
  static crossedAbove(crossing: VolumeCrossing, threshold: number): boolean {
    if (crossing.before === null || !Number.isFinite(threshold)) return false;
    return crossing.before <= threshold && crossing.after > threshold;
  }

  /** Après un changement d'adresse, la comparaison au relevé d'avant n'a plus de sens. */
  reset(): void {
    this.previous = new Map();
  }
}

/**
 * Le volume le plus rempli d'un hôte, pour la condition « un volume dépasse X % ».
 *
 * Rend `null` quand aucun volume n'a de mesure — auquel cas la condition doit répondre
 * **faux**, et non « oui, puisqu'on n'a rien vu de plein ». Le sens de la condition
 * l'impose : elle sert à protéger une sauvegarde, et répondre « il y a de la place »
 * parce qu'on n'a pas su lire revient à décider à l'aveugle.
 */
export function fullestVolume(volumes: readonly NasVolume[]): NasVolume | null {
  let fullest: NasVolume | null = null;
  for (const volume of volumes) {
    if (volume.usedPercent === null) continue;
    if (fullest === null || volume.usedPercent > (fullest.usedPercent ?? -1)) fullest = volume;
  }
  return fullest;
}
