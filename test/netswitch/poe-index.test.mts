import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { groupsOf, mapPoePorts } from '../../lib/netswitch/poe-index.mjs';
import type { PoePortRef } from '../../lib/netswitch/poe-mib.mjs';

const ports8 = [1, 2, 3, 4, 5, 6, 7, 8];

function refs(group: number, from: number, to: number): PoePortRef[] {
  const out: PoePortRef[] = [];
  for (let port = from; port <= to; port += 1) out.push({ group, port });
  return out;
}

test('identité : pethPsePortIndex vaut ifIndex, le cas le plus fréquent', () => {
  const mapping = mapPoePorts(ports8, refs(1, 1, 8));
  assert.ok(mapping !== null);
  assert.equal(mapping.strategy, 'identity');
  assert.deepEqual(mapping.byIfIndex.get(5), { group: 1, port: 5 });
  assert.equal(mapping.byIfIndex.size, 8);
});

test('identité : elle tient aussi quand seule une partie des ports est alimentée', () => {
  // Un switch 8 ports dont seuls les quatre premiers sont PoE. Chaque prise tombe sur
  // un port existant, et aucune n'est revendiquée deux fois : la correspondance est sûre.
  const mapping = mapPoePorts(ports8, refs(1, 1, 4));
  assert.ok(mapping !== null);
  assert.equal(mapping.strategy, 'identity');
  assert.equal(mapping.byIfIndex.size, 4);
  assert.equal(mapping.byIfIndex.has(7), false, 'un port sans PoE n\'en reçoit pas');
});

test('🔴 une prise qui tombe à côté fait rejeter l\'identité entière', () => {
  // Une correspondance partielle est exactement le cas où l'on croit avoir compris.
  const mapping = mapPoePorts(ports8, [...refs(1, 1, 4), { group: 1, port: 99 }]);
  assert.equal(mapping?.strategy, undefined, 'identity refusée');
});

test('🔴 deux groupes qui repartent à 1 ne sont pas une identité', () => {
  // Sur un châssis, le numéro de prise repart à 1 dans chaque groupe. `identity` y
  // donnerait la bonne réponse pour le premier groupe et la mauvaise pour tous les
  // autres — la pire des issues, parce qu'elle a l'air de marcher.
  const doubled = [...refs(1, 1, 4), ...refs(2, 1, 4)];
  const mapping = mapPoePorts(ports8, doubled);
  assert.notEqual(mapping?.strategy, 'identity');
});

test('ordinal : accepté seulement quand les deux listes ont exactement la même longueur', () => {
  // Huit ports, huit prises réparties sur deux groupes qui repartent à 1 : l'identité
  // ne tient pas, mais le rang, lui, est complet.
  const mapping = mapPoePorts(ports8, [...refs(2, 1, 4), ...refs(1, 1, 4)]);
  assert.ok(mapping !== null);
  assert.equal(mapping.strategy, 'ordinal');
  assert.deepEqual(mapping.byIfIndex.get(1), { group: 1, port: 1 }, 'les prises sont triées, pas prises dans l\'ordre du walk');
  assert.deepEqual(mapping.byIfIndex.get(5), { group: 2, port: 1 });
});

test('🔴 un switch 24 ports dont 12 sont PoE ne dit pas lesquels : on n\'invente pas', () => {
  const ports24 = Array.from({ length: 24 }, (_, i) => i + 1);
  // Les prises repartent à 1 par groupe, donc l'identité échoue ; et 12 ≠ 24, donc le
  // rang échoue aussi. Une hypothèse à 50 % n'est pas une correspondance.
  const mapping = mapPoePorts(ports24, [...refs(1, 1, 6), ...refs(2, 1, 6)]);
  assert.equal(mapping, null);
});

test('aucune prise, aucun port : pas de correspondance, et ce n\'est pas une anomalie', () => {
  assert.equal(mapPoePorts(ports8, []), null);
  assert.equal(mapPoePorts([], refs(1, 1, 4)), null);
});

test('groupsOf rend les groupes PSE à interroger, triés et dédoublonnés', () => {
  const mapping = mapPoePorts(ports8, [...refs(2, 1, 4), ...refs(1, 1, 4)]);
  assert.ok(mapping !== null);
  assert.deepEqual(groupsOf(mapping), [1, 2]);
});
