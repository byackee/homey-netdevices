/**
 * Les conversions d'unité communes aux lecteurs RFC 1628 et APC.
 *
 * Elles vivent ici plutôt que recopiées dans chaque lecteur parce que c'est exactement
 * la famille de bug que le plan §8.5 désigne comme indétectable : un facteur 10 ou 100
 * donne une valeur parfaitement crédible. 27,3 V et 273 V sont tous deux « une tension » ;
 * 25 min et 1500 min sont tous deux « une autonomie ». Aucun test ne les distingue si la
 * fixture est mal choisie, et aucun humain ne les distingue sur un tableau de bord.
 *
 * Règle unique et non négociable : **une entrée `null`, non finie ou physiquement
 * impossible rend `null`**, jamais une valeur rabotée. Zéro est une mesure ; l'absence
 * n'en est pas une (voir `snapshot.mts`).
 */

/**
 * Arrondit au dixième.
 *
 * Pas de la coquetterie : les capabilities Homey écrivent un point Insights à chaque
 * valeur *différente*. Laisser traîner les décimales d'un flottant ferait écrire à
 * chaque poll — toutes les dix secondes sur le groupe rapide (plan §8.6).
 */
export function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Convertit une valeur exprimée en dixièmes vers son unité.
 *
 * 🔴 Concerne `upsBatteryVoltage` (0,1 V), `upsInputFrequency` et `upsOutputFrequency`
 * (0,1 Hz) et les courants (0,1 A) — **mais pas** `upsInputVoltage` ni
 * `upsOutputVoltage`, qui sont en volts entiers (annexe A §1, piège n°1). Appliquer
 * cette fonction aux tensions AC diviserait un secteur à 230 V en 23 V : crédible,
 * donc invisible.
 *
 * Le signe est conservé : `upsBatteryCurrent` est un `Integer32` signé, négatif en
 * décharge, et forcer sa positivité effacerait précisément l'information utile.
 */
export function fromTenths(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return roundTenth(value / 10);
}

/**
 * Convertit des `TimeTicks` — des **centièmes de seconde** — en minutes.
 *
 * APC et CyberPower expriment l'autonomie ainsi ; la RFC 1628 la donne déjà en minutes
 * et Synology en secondes (annexe A §6d). Les quatre sources se rejoignent en minutes
 * ici et jamais plus haut, sinon la question se repose une fois par dialecte.
 *
 * Une valeur négative rend `null` : elle n'existe pas physiquement, et l'afficher
 * telle quelle vaudrait « autonomie : −7 min » au lieu d'« inconnue ».
 */
export function timeTicksToMinutes(ticks: number | null): number | null {
  if (ticks === null || !Number.isFinite(ticks) || ticks < 0) return null;
  return roundTenth(ticks / 6000);
}
