/**
 * Du compteur d'octets au débit, ou rien.
 *
 * Un compteur cumulé depuis le démarrage de l'agent n'apprend rien à personne : ce qu'on
 * veut voir, c'est un débit. Mais un débit se calcule sur une différence, et **une
 * différence fausse est invisible** — elle a l'air d'un débit. D'où la règle unique de ce
 * fichier : au moindre doute, `null`.
 *
 * Quatre doutes, tous rendus `null` :
 *
 * 1. Pas d'échantillon précédent — au premier relevé, il n'y a pas de débit, il y a un
 *    compteur. Publier `0` ferait apparaître un creux à chaque redémarrage de l'app.
 * 2. `ifCounterDiscontinuityTime` a changé : l'agent annonce lui-même que ses compteurs
 *    ont sauté. C'est exactement l'objet que la RFC 2863 a créé pour ça, et l'annexe
 *    (piège 8) demande de le regarder avant tout calcul de delta.
 * 3. Le compteur a **reculé**. Un Counter64 ne déborde pas en pratique — à 1 Gbit/s
 *    saturé en permanence il lui faut plus de quatre mille ans — donc un recul est un
 *    redémarrage d'agent, pas un débordement à rattraper.
 * 4. Le temps écoulé n'est pas strictement positif : deux relevés dans la même
 *    milliseconde donneraient une division par zéro déguisée en pointe de trafic.
 *
 * 🔴 Ce fichier ne traite **que** des Counter64 (`ifHCInOctets` / `ifHCOutOctets`). Les
 * Counter32 d'erreurs, eux, débordent pour de bon et ne passent jamais par ici : ils sont
 * publiés bruts (annexe, piège 8).
 */

/** Un relevé de compteurs, daté. */
export interface TrafficSample {
  octetsIn: number | null;
  octetsOut: number | null;
  discontinuityTicks: number | null;
  /** L'horloge de l'appelant, en millisecondes. Injectée pour que le calcul soit testable. */
  atMs: number;
}

export interface Throughput {
  rxMbps: number | null;
  txMbps: number | null;
}

export const NO_THROUGHPUT: Throughput = { rxMbps: null, txMbps: null };

/**
 * Le débit entre deux relevés, en Mbit/s.
 *
 * @param previous le relevé précédent, ou `null` au premier passage
 * @param current  le relevé qui vient d'arriver
 */
export function throughputBetween(
  previous: TrafficSample | null,
  current: TrafficSample,
): Throughput {
  if (previous === null) return NO_THROUGHPUT;

  const elapsedSeconds = (current.atMs - previous.atMs) / 1_000;
  if (!(elapsedSeconds > 0)) return NO_THROUGHPUT;

  // L'agent dit lui-même que ses compteurs ont sauté : aucune différence n'a de sens.
  // Seulement quand les deux valeurs sont connues — une absence n'est pas un saut.
  if (
    previous.discontinuityTicks !== null &&
    current.discontinuityTicks !== null &&
    previous.discontinuityTicks !== current.discontinuityTicks
  ) {
    return NO_THROUGHPUT;
  }

  return {
    rxMbps: rate(previous.octetsIn, current.octetsIn, elapsedSeconds),
    txMbps: rate(previous.octetsOut, current.octetsOut, elapsedSeconds),
  };
}

/**
 * Des octets et des secondes vers des mégabits par seconde.
 *
 * Le facteur 8 est le seul endroit où une erreur donne un résultat crédible : un débit
 * huit fois trop petit ressemble à un réseau calme. `test/netswitch/throughput.test.mts`
 * choisit ses valeurs pour que ×8, ÷8 et « rien » soient trois nombres distincts.
 */
function rate(before: number | null, after: number | null, seconds: number): number | null {
  if (before === null || after === null) return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  // Recul = redémarrage de l'agent. Voir l'en-tête : un Counter64 ne déborde pas.
  if (after < before) return null;

  const megabits = ((after - before) * 8) / 1_000_000;
  return round(megabits / seconds);
}

/** Deux décimales : au-delà, on afficherait une précision que l'échantillonnage n'a pas. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
