/**
 * Ce qui a changé entre deux relevés d'un port.
 *
 * Extrait du device pour la raison habituelle : `Homey.Device` ne s'instancie pas hors du
 * runtime Homey, donc une règle qui reste dans le device n'est vérifiable que sur du vrai
 * matériel. Or celle-ci décide de **déclencher ou non un Flow**, et un Flow qui part une
 * fois de trop réveille quelqu'un la nuit.
 *
 * 🔴 **Un franchissement, pas un état.** Un port qui reste éteint pendant trois jours ne
 * doit pas déclencher « le lien est tombé » toutes les dix secondes pendant trois jours.
 *
 * 🔴 **Le premier relevé ne déclenche rien.** Au démarrage de l'app, aucun état antérieur
 * n'est connu : traiter « inconnu → down » comme une chute ferait partir tous les Flows de
 * coupure de tous les ports éteints à chaque redémarrage de Homey.
 */

import type { LinkState } from './if-mib.mjs';
import type { PoeStatus } from './poe-mib.mjs';

/** Ce qui a bougé, et qui sert aussi d'état aux cartes de Flow filtrées. */
export interface LinkChangeSet {
  /** L'état courant, pour le sélecteur de la carte « le lien passe à X ». */
  link: LinkState;
  /** Le lien vient de passer à `up`. */
  cameUp: boolean;
  /** Le lien vient de quitter `up` pour un état qui n'est pas « inconnu ». */
  wentDown: boolean;
  /** L'état du lien a changé, quel que soit le sens. */
  linkChanged: boolean;
  /** Le PoE vient de passer en défaut — `fault` ou `otherFault`. */
  poeFaultRaised: boolean;
}

/** Ce que l'observation attend d'un relevé. Un sous-ensemble de `PortSnapshot`. */
export interface ObservablePort {
  link: LinkState;
  poe: { status: PoeStatus } | null;
}

const NOTHING: Omit<LinkChangeSet, 'link'> = {
  cameUp: false,
  wentDown: false,
  linkChanged: false,
  poeFaultRaised: false,
};

/** Les deux états PoE qui méritent qu'on réveille quelqu'un. */
function isFault(status: PoeStatus | null): boolean {
  return status === 'fault' || status === 'otherFault';
}

export class LinkChangeDetector {
  private previousLink: LinkState | null = null;
  private previousPoeFault: boolean | null = null;

  /**
   * Compare au relevé précédent.
   *
   * ⚠️ `'unknown'` n'est pas un état comme les autres : c'est « on n'a pas su lire ».
   * Passer de `up` à `unknown` n'est pas une chute du lien, et le traiter comme telle
   * ferait partir un Flow de coupure à chaque paquet SNMP perdu. On mémorise donc
   * l'inconnu — pour ne pas déclencher au retour non plus — mais on ne déclenche jamais
   * dessus.
   */
  observe(port: ObservablePort): LinkChangeSet {
    const previous = this.previousLink;
    const link = port.link;
    this.previousLink = link;

    const fault = port.poe === null ? null : isFault(port.poe.status);
    const previousFault = this.previousPoeFault;
    this.previousPoeFault = fault;

    // Premier relevé : rien n'a « changé », on prend simplement acte.
    if (previous === null) return { link, ...NOTHING };

    const meaningful = previous !== 'unknown' && link !== 'unknown';

    return {
      link,
      cameUp: meaningful && previous !== 'up' && link === 'up',
      wentDown: meaningful && previous === 'up' && link !== 'up',
      linkChanged: meaningful && previous !== link,
      poeFaultRaised: fault === true && previousFault === false,
    };
  }

  /**
   * Oublie l'état antérieur.
   *
   * Appelé quand l'adresse change : l'état d'avant décrivait un autre appareil, et le
   * comparer au nouveau ferait partir un Flow qui ne décrit aucun événement réel.
   */
  reset(): void {
    this.previousLink = null;
    this.previousPoeFault = null;
  }
}

/** La valeur du sélecteur « n'importe lequel » de la carte « le lien passe à X ». */
export const ANY_LINK = 'any';

/**
 * Le filtre de la carte « le lien passe à X ».
 *
 * Un sélecteur absent ou vide vaut « n'importe lequel » : une carte posée avant que
 * l'argument existe ne doit pas cesser silencieusement de se déclencher.
 */
export function matchesLinkFilter(wanted: unknown, actual: LinkState): boolean {
  if (wanted === undefined || wanted === null || wanted === '' || wanted === ANY_LINK) return true;
  return wanted === actual;
}
