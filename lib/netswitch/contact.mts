/**
 * Le suivi de contact d'un port.
 *
 * Volontairement plus simple que celui de l'onduleur : le gel du §3.8 — garder l'état
 * « sur batterie » quand le NAS relais s'éteint en cours de coupure — n'a aucun sens ici.
 * Un switch qui ne répond plus est un switch injoignable, point. Ce qui reste commun,
 * c'est le seuil : {@link FAILURES_BEFORE_VERDICT} échecs avant de déclarer l'appareil
 * indisponible, pour qu'un paquet UDP perdu ne fasse pas clignoter la fiche d'appareil.
 *
 * 🔴 Un switch 48 ports fait 48 appareils Homey qui interrogent **le même agent**. Un
 * agent qui bride les requêtes en refusera donc une partie, à chaque tick, pour toujours.
 * C'est précisément ce que le seuil absorbe — et c'est pourquoi il compte les échecs
 * *consécutifs* d'un même port, jamais les échecs de l'appareil vu globalement.
 */

import { FAILURES_BEFORE_VERDICT } from '../device/rhythm.mjs';
import type { PortLive } from './port.mjs';

export type Availability = 'available' | 'unavailable';

/** Ce que le suivi conclut après une tentative. */
export interface ContactOutcome {
  availability: Availability;
  /** Échecs consécutifs. Remis à zéro par le premier succès. */
  failures: number;
  /** Vrai quand l'échec est encore sous le seuil : rien à annoncer, rien à écrire. */
  absorbing: boolean;
  /** Ce qui a été lu, ou `null` quand la tentative a échoué. `null` veut dire « n'écris rien ». */
  live: PortLive | null;
}

export class PortContactTracker {
  private failures = 0;

  succeeded(live: PortLive): ContactOutcome {
    this.failures = 0;
    return { availability: 'available', failures: 0, absorbing: false, live };
  }

  failed(): ContactOutcome {
    this.failures += 1;
    const absorbing = this.failures < FAILURES_BEFORE_VERDICT;
    return {
      availability: absorbing ? 'available' : 'unavailable',
      failures: this.failures,
      absorbing,
      // 🔴 `null`, et non un `PortLive` vide : un relevé raté ne fait pas tomber le lien.
      // Écrire « down » ici déclencherait les Flows de coupure de lien à chaque paquet perdu.
      live: null,
    };
  }

  /**
   * Repart de zéro.
   *
   * Appelé quand l'adresse ou la communauté change : les échecs d'avant portaient sur une
   * conversation qui n'existe plus, et les compter contre la nouvelle ferait déclarer
   * indisponible un appareil qui vient tout juste de répondre.
   */
  reset(): void {
    this.failures = 0;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
