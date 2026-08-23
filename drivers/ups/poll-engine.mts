/**
 * La mécanique du device onduleur, **sans une seule ligne de Homey**.
 *
 * Tout ce qui décide quelque chose vit ici : les deux rythmes, la garde de réentrance,
 * l'escalade des échecs, la règle du §3.8, et la détection de changement qui arme les
 * Flow cards. `device.mts` au-dessus n'est plus qu'un adaptateur — il branche des
 * timers Homey sur ces décisions et écrit des capabilities.
 *
 * Ce découpage n'est pas cosmétique : `Homey.Device` ne s'instancie pas hors du
 * runtime Homey. Une logique de coupure de courant qu'aucun test ne peut atteindre
 * est une logique qu'on découvre fausse le soir où le courant saute. C'est le même
 * motif que `capability-map.mts` de netprinter, pour la même raison.
 */

import type { UpsStatus } from '../../lib/ups/nut-status.mjs';
import type { UpsLive } from '../../lib/ups/snapshot.mjs';
import {
  DETAIL_RHYTHM,
  FAILURES_BEFORE_VERDICT,
  LIVE_RHYTHM,
  PollGate,
  intervalMs,
  type Rhythm,
} from '../../lib/device/rhythm.mjs';

// Réexportés : les tests et le device les importaient déjà d'ici, et le déplacement ne
// doit pas casser leurs points d'entrée.
export { DETAIL_RHYTHM, FAILURES_BEFORE_VERDICT, LIVE_RHYTHM, PollGate, intervalMs, type Rhythm };

/**
 * Combien de relevés consécutifs doivent échouer avant qu'on en tire une conclusion.
 *
 * SNMP est de l'UDP : un datagramme perdu n'est pas une panne. Trois échecs de suite
 * valent ~30 s au rythme rapide — assez pour distinguer une perte réelle d'un paquet
 * égaré, assez peu pour rester utile pendant une coupure.
 */
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
  /** Seuil atteint depuis un état normal : l'appareil est déclaré injoignable. */
  | 'unreachable'
  /** Seuil atteint alors que le dernier état connu était `battery` (§3.8). */
  | 'lost-during-outage';

export interface ContactOutcome {
  reason: ContactReason;
  /**
   * Ce qu'il faut publier sur les capabilities, ou `null` pour **ne rien écrire**.
   *
   * `null` n'est pas « pas de valeur » : c'est « garde ce qui est affiché ». C'est par
   * là que l'état reste figé sur `battery` pendant que le NAS est éteint.
   */
  live: UpsLive | null;
  availability: Availability;
  /** Vrai **une seule fois**, au franchissement du seuil pendant une coupure. */
  contactLostDuringOutage: boolean;
  /** Échecs consécutifs, pour la trace. */
  failures: number;
}

/**
 * Ce qu'on publie quand on a atteint le seuil depuis un état normal.
 *
 * 🔴 `unknown`, pas `off` et pas `normal`. Le vocabulaire commun n'a pas de valeur
 * « hors ligne » et c'est heureux : `off` voudrait dire « l'onduleur est éteint », ce
 * qu'on ne sait pas. Les mesures repartent à `null` — « on ne sait plus » — et surtout
 * pas à `0`, qui lèverait `alarm_battery` et `alarm_ups_onbattery` en même temps,
 * c'est-à-dire une fausse alerte de coupure de courant (plan §8.5).
 *
 * Les alarmes retombent à `false` et non à `true` : une alarme qu'on ne sait pas lire
 * n'est pas une alarme qui sonne. Aucun déclencheur parasite n'en sort, puisqu'on ne
 * peut arriver ici que depuis un état où elles étaient déjà retombées.
 */
export const LIVE_UNKNOWN: UpsLive = {
  status: 'unknown',
  alarms: { onBattery: false, batteryLow: false, overload: false, replaceBattery: false },
  alarmSummary: null,
  batteryCharge: null,
  runtimeMinutes: null,
  load: null,
};

/**
 * Le trou logique du relais NAS, tenu par une machine à états (plan §3.8).
 *
 * Le Synology qui relaie l'onduleur est **lui-même alimenté par l'onduleur**. DSM
 * l'éteint après un délai sur batterie : la source de données disparaît **pendant**
 * l'événement qu'elle sert à détecter. Le socle naïf y verrait une banale
 * injoignabilité et remettrait l'état à zéro — donc annoncerait implicitement que
 * tout va bien, au moment précis où c'est faux.
 *
 * D'où deux pertes de contact, et non une :
 * - depuis un état normal ⇒ injoignable, état publié `unknown` ;
 * - depuis `battery` ⇒ **rien n'est réécrit**, l'état reste figé sur `battery`, et un
 *   déclencheur distinct part. On ne prétend pas savoir que le courant est revenu.
 *
 * Dans les deux cas l'appareil devient indisponible au bout de trois échecs, parce
 * qu'il l'est réellement : le figeage porte sur ce qu'on **affirme**, pas sur ce qu'on
 * **prétend joindre**. Cacher l'injoignabilité serait un second mensonge.
 */
export class ContactTracker {
  private failures = 0;
  private lastKnownStatus: UpsStatus | null = null;
  /**
   * Le dernier relevé disait-il « sur batterie » ?
   *
   * Distinct de {@link lastKnownStatus}, et c'est tout l'objet du correctif : `status`
   * et `alarms.onBattery` sont deux notions différentes qui divergent pour de bon.
   * `OB BYPASS` rend `status: 'bypass'` avec `onBattery: true` ; un agent RFC 1628 en
   * `booster(6)` avec une ligne `onBattery` dans `upsAlarmTable` fait de même.
   *
   * Le gel du §3.8 doit s'armer sur la **même** notion que celle qui a déclenché
   * `ups_went_on_battery`, sans quoi il ne s'arme pas là où il devrait — et l'app
   * annonce « le courant est revenu » au moment précis où elle perd le contact.
   */
  private lastKnownOnBattery = false;
  private available = true;
  /** Empêche le déclencheur de coupure de repartir à chaque tick suivant le seuil. */
  private outageAnnounced = false;

  /** Un relevé rapide a réussi. */
  succeeded(live: UpsLive): ContactOutcome {
    this.failures = 0;
    this.outageAnnounced = false;
    this.lastKnownStatus = live.status;
    this.lastKnownOnBattery = live.alarms.onBattery;

    const availability: Availability = 'available';
    this.available = true;

    return {
      reason: 'ok',
      live,
      availability,
      contactLostDuringOutage: false,
      failures: 0,
    };
  }

  /** Un relevé rapide a échoué. */
  failed(): ContactOutcome {
    this.failures += 1;

    if (this.failures < FAILURES_BEFORE_VERDICT) {
      // Sous le seuil, on n'écrit rien du tout. netprinter posait « offline » dès le
      // premier échec ; à 300 s c'était raisonnable, à 10 s cela ferait clignoter
      // l'état trente fois plus souvent pour un paquet UDP perdu.
      return {
        reason: 'absorbing',
        live: null,
        availability: this.available ? 'available' : 'unavailable',
        contactLostDuringOutage: false,
        failures: this.failures,
      };
    }

    // Sur la même notion que le déclencheur, jamais sur `status` : voir
    // {@link lastKnownOnBattery}.
    const duringOutage = this.lastKnownOnBattery;
    const announce = duringOutage && !this.outageAnnounced;
    if (announce) this.outageAnnounced = true;
    this.available = false;

    return {
      reason: duringOutage ? 'lost-during-outage' : 'unreachable',
      live: duringOutage ? null : LIVE_UNKNOWN,
      availability: 'unavailable',
      contactLostDuringOutage: announce,
      failures: this.failures,
    };
  }

  /** Le dernier état réellement lu, ou `null` avant le premier relevé réussi. */
  get lastStatus(): UpsStatus | null {
    return this.lastKnownStatus;
  }

  /**
   * Remet le compteur à zéro sans rien affirmer, après un changement d'adresse ou de
   * communauté : les échecs d'avant portaient sur un autre appareil.
   *
   * « Sans rien affirmer » vaut aussi pour l'état : garder `lastKnownOnBattery` gèlerait
   * le **nouvel** appareil sur une coupure observée chez l'ancien, et le premier échec
   * de contact le figerait sur « batterie » au lieu de le dire injoignable.
   */
  reset(): void {
    this.failures = 0;
    this.outageAnnounced = false;
    this.lastKnownStatus = null;
    this.lastKnownOnBattery = false;
    this.available = true;
  }
}

/** Les fronts que les Flow cards attendent, calculés par comparaison au relevé précédent. */
export interface UpsChangeSet {
  /** L'état commun a changé — le déclencheur générique « état changé ». */
  statusChanged: boolean;
  status: UpsStatus;
  /** Front montant de `onBattery` : c'est **le** déclencheur qui justifie l'app. */
  wentOnBattery: boolean;
  /** Front descendant de `onBattery`. */
  mainsRestored: boolean;
  batteryLowRaised: boolean;
  overloadRaised: boolean;
  replaceBatteryRaised: boolean;
  /**
   * Autonomie avant et après, en minutes.
   *
   * Le seuil du déclencheur « autonomie sous X » appartient à **chaque Flow**, pas au
   * device : deux Flows peuvent vouloir 15 min et 5 min. Le franchissement ne peut donc
   * pas se calculer ici. On expose les deux bornes, et le `runListener` de la carte
   * teste `avant > X ≥ après` — un vrai franchissement, propre à chaque Flow, au lieu
   * d'un déclenchement à chaque tick passé sous le seuil.
   */
  runtimeBefore: number | null;
  runtimeAfter: number | null;
}

/**
 * Compare deux relevés successifs.
 *
 * Toutes les alarmes partent sur **front montant** seulement : une batterie à remplacer
 * le reste des semaines, et notifier à chaque relevé de 10 s serait une notification
 * toutes les dix secondes.
 *
 * Deux choix sur le tout premier relevé, opposés et délibérés :
 * - `statusChanged` ne part **pas**. Sinon chaque redémarrage de l'app rejouerait un
 *   « l'état a changé » qui n'a changé pour personne.
 * - `wentOnBattery` **part** si l'app démarre alors que l'onduleur est déjà sur
 *   batterie. C'est le déclencheur qui coupe les appareils non essentiels : le rejouer
 *   une fois de trop coûte infiniment moins cher que de le manquer une fois.
 */
export class UpsChangeDetector {
  private previous: UpsLive | null = null;

  observe(live: UpsLive): UpsChangeSet {
    const before = this.previous;
    this.previous = live;

    const wasOnBattery = before?.alarms.onBattery ?? false;

    return {
      statusChanged: before !== null && before.status !== live.status,
      status: live.status,
      wentOnBattery: !wasOnBattery && live.alarms.onBattery,
      mainsRestored: wasOnBattery && !live.alarms.onBattery,
      batteryLowRaised: !(before?.alarms.batteryLow ?? false) && live.alarms.batteryLow,
      overloadRaised: !(before?.alarms.overload ?? false) && live.alarms.overload,
      replaceBatteryRaised: !(before?.alarms.replaceBattery ?? false) && live.alarms.replaceBattery,
      runtimeBefore: before?.runtimeMinutes ?? null,
      runtimeAfter: live.runtimeMinutes,
    };
  }

  /**
   * Vrai si l'autonomie **vient de franchir** le seuil vers le bas.
   *
   * Les deux bornes doivent être connues : un `null` d'un côté veut dire « on ne sait
   * pas », et on ne déclenche pas une extinction de NAS sur ce qu'on ne sait pas.
   */
  static crossedBelow(change: UpsChangeSet, threshold: number): boolean {
    const { runtimeBefore: before, runtimeAfter: after } = change;
    if (before === null || after === null) return false;
    return before > threshold && after <= threshold;
  }

  /** Après un changement d'appareil, la comparaison au relevé d'avant n'a plus de sens. */
  reset(): void {
    this.previous = null;
  }
}

/** La valeur du sélecteur d'état qui accepte n'importe quel état. */
export const ANY_STATUS = 'any';

/**
 * Le filtre du déclencheur « l'état passe à X ».
 *
 * Une ligne, et pourtant deux façons de la rater en silence, toutes deux invisibles à la
 * compilation : oublier le cas « n'importe quel état », auquel cas le Flow le plus
 * courant ne part **jamais** ; ou comparer à `undefined` quand l'argument manque, auquel
 * cas il part **toujours**. Un déclencheur qui ne part pas ne produit aucune erreur —
 * personne ne vient s'en plaindre, on croit juste que l'onduleur n'a rien signalé.
 */
export function matchesStatusFilter(wanted: unknown, actual: UpsStatus): boolean {
  if (wanted === ANY_STATUS) return true;
  return typeof wanted === 'string' && wanted === actual;
}
