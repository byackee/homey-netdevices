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
 * 3. Le compteur a **reculé** et rien ne permet de trancher. Voir {@link rate} : la
 *    réponse dépend de la largeur du compteur, et elle est opposée d'un cas à l'autre.
 * 4. Le temps écoulé n'est pas strictement positif : deux relevés dans la même
 *    milliseconde donneraient une division par zéro déguisée en pointe de trafic.
 *
 * 🔴 Ce fichier traite les deux largeurs. Les compteurs d'**erreurs**, eux, ne passent
 * jamais par ici : ils sont publiés bruts (annexe, piège 8).
 */

/** 2³² octets — le tour d'horloge d'un Counter32 de l'`ifTable`. */
const WRAP_32 = 4_294_967_296;

/** Un relevé de compteurs, daté. */
export interface TrafficSample {
  octetsIn: number | null;
  octetsOut: number | null;
  /** 64 pour l'`ifXTable`, 32 pour le repli `ifTable`. Décide du sens d'un recul. */
  octetsWidth: 32 | 64;
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
  /**
   * Le débit négocié du port, en Mbit/s, ou `null` s'il est inconnu.
   *
   * Sert **uniquement** à juger un recul de compteur 32 bits. Sans lui, rien ne
   * distingue un débordement d'un redémarrage d'agent, et le repli 32 bits se tait.
   */
  speedMbps: number | null = null,
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

  // Deux relevés de largeurs différentes ne se soustraient pas : l'agent a changé de
  // table entre-temps, et la différence n'aurait aucun sens.
  if (previous.octetsWidth !== current.octetsWidth) return NO_THROUGHPUT;

  return {
    rxMbps: rate(previous.octetsIn, current.octetsIn, elapsedSeconds, current.octetsWidth, speedMbps),
    txMbps: rate(previous.octetsOut, current.octetsOut, elapsedSeconds, current.octetsWidth, speedMbps),
  };
}

/**
 * Des octets et des secondes vers des mégabits par seconde.
 *
 * Le facteur 8 est le seul endroit où une erreur donne un résultat crédible : un débit
 * huit fois trop petit ressemble à un réseau calme. `test/netswitch/throughput.test.mts`
 * choisit ses valeurs pour que ×8, ÷8 et « rien » soient trois nombres distincts.
 */
function rate(
  before: number | null,
  after: number | null,
  seconds: number,
  width: 32 | 64,
  speedMbps: number | null,
): number | null {
  if (before === null || after === null) return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;

  let delta = after - before;

  if (delta < 0) {
    // Un Counter64 ne déborde pas en pratique — à 1 Gbit/s saturé en permanence il lui
    // faut plus de quatre mille ans. Un recul y est donc un redémarrage d'agent.
    if (width === 64) return null;

    // Un Counter32, lui, déborde toutes les 34 secondes à 1 Gbit/s. Le recul est donc
    // vraisemblablement un tour d'horloge — mais « vraisemblablement » ne suffit pas :
    // deux conditions doivent tenir, sans quoi le débit serait inventé.
    const corrige = delta + WRAP_32;

    // (a) On doit connaître la vitesse du lien. Sans elle, rien ne distingue un
    //     débordement d'un redémarrage, et un redémarrage « rattrapé » afficherait une
    //     pointe de plusieurs gigabits sortie de nulle part.
    if (speedMbps === null || !(speedMbps > 0)) return null;

    const platefondOctets = (speedMbps * 1_000_000 * seconds) / 8;

    // (b) 🔴 Deux tours d'horloge doivent être **impossibles**. S'ils ne le sont pas, un
    //     seul tour et deux tours sont indiscernables, et choisir « un » serait diviser
    //     le débit réel par deux tout en ayant l'air juste. À 1 Gbit/s la fenêtre bascule
    //     vers 34 secondes : au rythme de dix secondes on est couvert, à la minute non.
    if (platefondOctets >= WRAP_32) return null;

    // (c) Le débit rattrapé doit tenir dans ce que le lien peut porter. Sinon ce n'était
    //     pas un débordement.
    if (corrige > platefondOctets) return null;

    delta = corrige;
  }

  const megabits = (delta * 8) / 1_000_000;
  return round(megabits / seconds);
}

/** Deux décimales : au-delà, on afficherait une précision que l'échantillonnage n'a pas. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
