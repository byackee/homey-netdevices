import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fromTenths, roundTenth, timeTicksToMinutes } from '../../lib/ups/units.mjs';

test('🔴 les fixtures d\'unité distinguent bien les conversions candidates', () => {
  // Garde-fou sur les tests eux-mêmes (plan §8.5) : avec une valeur mal choisie,
  // « diviser par dix » et « ne rien faire » donnent le même résultat, la suite passe au
  // vert, et le facteur 10 part en production.
  assert.equal(new Set([273, 273 / 10, 273 * 10]).size, 3);
  assert.equal(new Set([150_000, 150_000 / 60, 150_000 / 6000]).size, 3);
});

test('fromTenths divise par dix et arrondit au dixième', () => {
  assert.equal(fromTenths(273), 27.3, '273 décivolts font 27,3 V');
  assert.notEqual(fromTenths(273), 273, 'la valeur brute ne doit pas passer telle quelle');
  assert.equal(fromTenths(0), 0, 'zéro est une mesure, pas une absence');
});

test('fromTenths garde le signe : un courant batterie est négatif en décharge', () => {
  assert.equal(fromTenths(-5), -0.5);
});

test('fromTenths refuse ce qui n\'est pas un nombre', () => {
  assert.equal(fromTenths(null), null);
  assert.equal(fromTenths(Number.NaN), null);
  assert.equal(fromTenths(Number.POSITIVE_INFINITY), null);
});

test('timeTicksToMinutes divise par 6000, pas par 60', () => {
  assert.equal(timeTicksToMinutes(150_000), 25, '150 000 centièmes de seconde font 25 min');
  assert.notEqual(timeTicksToMinutes(150_000), 2500, 'ce ne sont pas des secondes');
  assert.notEqual(timeTicksToMinutes(150_000), 150_000, 'ce ne sont pas déjà des minutes');
  assert.equal(timeTicksToMinutes(0), 0);
});

test('timeTicksToMinutes refuse une autonomie négative', () => {
  assert.equal(timeTicksToMinutes(-1), null, 'une autonomie négative n\'existe pas');
  assert.equal(timeTicksToMinutes(null), null);
  assert.equal(timeTicksToMinutes(Number.NaN), null);
});

test('roundTenth ne fabrique pas de précision qu\'on n\'a pas', () => {
  assert.equal(roundTenth(27.249), 27.2);
  assert.equal(roundTenth(27.25), 27.3);
});
