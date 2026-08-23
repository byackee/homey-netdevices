import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { throughputBetween, type TrafficSample } from '../../lib/netswitch/throughput.mjs';

function sample(octetsIn: number | null, octetsOut: number | null, atMs: number, ticks: number | null = 100): TrafficSample {
  return { octetsIn, octetsOut, discontinuityTicks: ticks, atMs };
}

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
