import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NO_THROUGHPUT, throughputBetween, type TrafficSample } from '../../lib/netswitch/throughput.mjs';

function sample(
  octetsIn: number | null,
  octetsOut: number | null,
  atMs: number,
  ticks: number | null = 100,
  octetsWidth: 32 | 64 = 64,
): TrafficSample {
  return { octetsIn, octetsOut, octetsWidth, discontinuityTicks: ticks, atMs };
}

/** Un relevé 32 bits, les deux sens égaux — la forme des essais de débordement. */
const c32 = (octets: number, atMs: number): TrafficSample => sample(octets, octets, atMs, 0, 32);

test('🔴 les fixtures de débit distinguent ×8, ÷8 et « rien »', () => {
  // Garde-fou sur le test lui-même : le facteur 8 est le seul endroit où une erreur
  // donne un résultat crédible — un réseau huit fois trop calme a l'air d'un réseau calme.
  const octets = 12_500_000;
  const seconds = 10;
  const candidates = [
    (octets * 8) / seconds / 1e6,
    (octets / 8) / seconds / 1e6,
    octets / seconds / 1e6,
  ];
  assert.equal(new Set(candidates).size, 3);
});

test('le débit est en mégabits par seconde, octets × 8', () => {
  const before = sample(0, 0, 0);
  const after = sample(12_500_000, 25_000_000, 10_000);
  const rates = throughputBetween(before, after);
  assert.equal(rates.rxMbps, 10, '12,5 Mo en 10 s font 10 Mbit/s');
  assert.equal(rates.txMbps, 20, '25 Mo en 10 s font 20 Mbit/s');
  assert.notEqual(rates.rxMbps, 1.25, 'les octets ne sont pas des bits');
  assert.notEqual(rates.rxMbps, 1_250_000, 'ce ne sont pas des bit/s');
});

test('🔴 sans échantillon précédent il n\'y a pas de débit — et surtout pas zéro', () => {
  // Publier 0 ferait apparaître un creux de trafic à chaque redémarrage de l'app, sur
  // tous les ports à la fois. C'est une courbe fausse, pas une courbe manquante.
  const rates = throughputBetween(null, sample(999, 999, 1_000));
  assert.equal(rates.rxMbps, null);
  assert.equal(rates.txMbps, null);
});

test('🔴 un saut de compteur annoncé par l\'agent annule le calcul', () => {
  // `ifCounterDiscontinuityTime` existe exactement pour ça (RFC 2863, annexe piège 8).
  const before = sample(1_000_000_000, 1_000_000_000, 0, 100);
  const after = sample(12_500_000, 12_500_000, 10_000, 250);
  const rates = throughputBetween(before, after);
  assert.equal(rates.rxMbps, null);
  assert.equal(rates.txMbps, null);
});

test('un compteur qui recule est un agent redémarré, pas un débordement à rattraper', () => {
  // Un Counter64 saturé à 1 Gbit/s met plus de quatre mille ans à déborder : un recul
  // ne s'explique jamais par un wraparound.
  const before = sample(10_000_000_000, 10_000_000_000, 0);
  const after = sample(5_000, 20_000_000_000, 10_000);
  const rates = throughputBetween(before, after);
  assert.equal(rates.rxMbps, null, 'le sens qui recule est abandonné');
  assert.ok(rates.txMbps !== null && rates.txMbps > 0, 'l\'autre sens reste calculable');
});

test('deux relevés dans la même milliseconde ne donnent pas une pointe de trafic', () => {
  const rates = throughputBetween(sample(0, 0, 5_000), sample(1_000_000, 1_000_000, 5_000));
  assert.equal(rates.rxMbps, null);
});

test('une horloge qui recule ne produit pas un débit négatif', () => {
  const rates = throughputBetween(sample(0, 0, 10_000), sample(1_000_000, 1_000_000, 4_000));
  assert.equal(rates.rxMbps, null);
});

test('un compteur absent — SNMPv1, où le Counter64 n\'existe pas — reste absent', () => {
  const rates = throughputBetween(sample(null, null, 0), sample(null, null, 10_000));
  assert.equal(rates.rxMbps, null);
  assert.equal(rates.txMbps, null);
});

test('une discontinuité inconnue des deux côtés ne bloque pas le calcul', () => {
  // Un agent sans `ifXTable` complet ne publie pas cet objet. Son absence n'est pas un
  // saut : le contrôle du recul suffit alors à protéger le calcul.
  const rates = throughputBetween(sample(0, 0, 0, null), sample(12_500_000, 0, 10_000, null));
  assert.equal(rates.rxMbps, 10);
});

test('le débit est arrondi au centième, sans inventer de précision', () => {
  const rates = throughputBetween(sample(0, 0, 0), sample(1_234_567, 0, 10_000));
  assert.equal(rates.rxMbps, 0.99);
});

// ---------------------------------------------------------------------------
// Le repli 32 bits, et ce qu'un recul veut dire selon la largeur du compteur
// ---------------------------------------------------------------------------

/** 2³² octets — le tour d'horloge d'un Counter32. */
const WRAP = 4_294_967_296;


/**
 * 🔴 Un recul de compteur ne veut pas dire la même chose selon sa largeur, et les deux
 * réponses sont opposées.
 *
 * Un Counter64 ne déborde pas en pratique — quatre mille ans à 1 Gbit/s saturé — donc un
 * recul y est un redémarrage d'agent. Un Counter32 déborde toutes les 34 secondes au même
 * débit. Appliquer la règle du 64 bits au 32 bits effacerait un débit bien réel à chaque
 * tour d'horloge ; appliquer l'inverse inventerait des gigabits à chaque redémarrage.
 */
test('🔴 un recul sur 64 bits reste un redémarrage, jamais un débordement', () => {
  const avant = sample(4_000_000_000, 4_000_000_000, 0, 0, 64);
  const apres = sample(1_000, 1_000, 10_000, 0, 64);
  assert.deepEqual(throughputBetween(avant, apres, 1000), NO_THROUGHPUT);
});

test('🔴 un débordement 32 bits est rattrapé, et rend le vrai débit', () => {
  // 12,5 Mo en 10 s = 10 Mbit/s. Le compteur passe juste au-dessus du tour d'horloge.
  const octetsTransferes = 12_500_000;
  const avant = c32(WRAP - 500_000, 0);
  const apres = c32(octetsTransferes - 500_000, 10_000);

  const r = throughputBetween(avant, apres, 1000);
  assert.equal(r.rxMbps, 10, 'le tour d’horloge doit être ajouté, pas ignoré');
  assert.equal(r.txMbps, 10);
});

test('🔴 sans vitesse de lien connue, un recul 32 bits ne se rattrape pas', () => {
  // Rien ne distingue alors un débordement d'un redémarrage : un redémarrage « rattrapé »
  // afficherait une pointe de plusieurs gigabits sortie de nulle part.
  const avant = c32(WRAP - 500_000, 0);
  const apres = c32(12_000_000, 10_000);
  assert.deepEqual(throughputBetween(avant, apres, null), NO_THROUGHPUT);
});

test('🔴 quand deux tours d’horloge sont possibles, le débit se tait', () => {
  // À 1 Gbit/s, 2³² octets passent en 34 s. Sur une fenêtre de 60 s, un tour et deux
  // tours sont indiscernables — et choisir « un » diviserait le débit réel par deux tout
  // en ayant l'air juste. C'est le cas où il faut refuser de répondre.
  const avant = c32(WRAP - 500_000, 0);
  const apres = c32(500_000, 60_000);
  assert.deepEqual(throughputBetween(avant, apres, 1000), NO_THROUGHPUT);

  // La même différence sur 10 s, elle, est décidable.
  const court = throughputBetween(c32(WRAP - 500_000, 0), c32(500_000, 10_000), 1000);
  assert.ok(court.rxMbps !== null && court.rxMbps > 0, 'décidable sur une fenêtre courte');
});

test('🔴 un rattrapage qui dépasse la capacité du lien est refusé', () => {
  // 100 Mbit/s ne peut pas porter 4 Go en 10 s. Ce n'était donc pas un débordement.
  const avant = c32(WRAP - 100, 0);
  const apres = c32(4_000_000_000, 10_000);
  assert.deepEqual(throughputBetween(avant, apres, 100), NO_THROUGHPUT);
});

test('deux relevés de largeurs différentes ne se soustraient pas', () => {
  // L'agent a changé de table entre les deux : la différence n'aurait aucun sens.
  assert.deepEqual(
    throughputBetween(sample(1_000, 1_000, 0, 0, 64), c32(2_000, 10_000), 1000),
    NO_THROUGHPUT,
  );
});
