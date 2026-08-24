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

/**
 * 🔴 Ce test affirmait le contraire, et il avait tort.
 *
 * Il disait : « chaque prise tombe sur un port existant, et aucune n'est revendiquée
 * deux fois : la correspondance est **sûre** ». Elle ne l'est pas. Les mêmes quatre
 * prises numérotées 1 à 4 décrivent aussi bien un switch dont les ports PoE sont les
 * quatre premiers qu'un switch dont ils sont les quatre derniers — la table PoE ne dit
 * pas lesquels, et l'accepter revient à couper la caméra d'un autre port une fois sur
 * deux.
 *
 * Le test encodait donc le défaut au lieu de le prévenir : il passait, et le code qu'il
 * couvrait était faux. C'est le cas le plus coûteux d'un jeu d'essai — celui qui donne
 * l'assurance de ce qu'il ne vérifie pas.
 */
test('🔴 un sous-ensemble de ports alimentés demande une preuve, il ne se présume pas', () => {
  assert.equal(mapPoePorts(ports8, refs(1, 1, 4)), null, 'sans preuve : refusé');

  // Avec la preuve, l'hypothèse tient — et c'est bien le même switch qu'avant.
  const mapping = mapPoePorts(ports8, refs(1, 1, 4), {
    delivering: [{ group: 1, port: 2 }],
    linkUp: [2, 6],
  });
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

// ---------------------------------------------------------------------------
// Le sous-ensemble strict : deux switchs indiscernables, une seule bonne réponse
// ---------------------------------------------------------------------------

/**
 * 🔴 `pethPsePortIndex` n'est pas un `ifIndex`.
 *
 * La RFC 3621 n'en dit que « un index qui identifie la prise dans son groupe ». Sur
 * beaucoup de switchs il vaut le numéro de port, donc l'`ifIndex` ; sur d'autres non — et
 * rien dans la table ne permet de trancher.
 *
 * Les deux switchs ci-dessous publient **exactement la même table PoE** : huit prises
 * numérotées 1 à 8, sur vingt-quatre ports. Dans le premier, les prises PoE *sont* les
 * ports 1 à 8. Dans le second, elles sont sur les ports 17 à 24. Accepter l'hypothèse
 * dans le second cas fait couper la caméra d'un autre port — mot pour mot ce que
 * l'en-tête de `poe-index.mts` dit vouloir éviter.
 *
 * La preuve qui les sépare est physique : une prise qui **délivre du courant** est reliée
 * à un port dont le lien est **actif**. Un appareil alimenté par PoE ne tire pas de
 * courant sans être branché.
 */

const VINGT_QUATRE_PORTS = Array.from({ length: 24 }, (_, i) => i + 1);
const HUIT_PRISES = Array.from({ length: 8 }, (_, i) => ({ group: 1, port: i + 1 }));

test('🔴 sans preuve, un sous-ensemble strict est refusé plutôt que présumé', () => {
  // Aucune prise alimentée : il n'y a rien à corroborer. Le PoE n'est pas déclaré tant
  // que rien ne l'atteste — la confiance se gagne au lieu de se supposer, ce qui est la
  // bonne façon de traiter une commande qui coupe une alimentation.
  assert.equal(mapPoePorts(VINGT_QUATRE_PORTS, HUIT_PRISES), null);
  assert.equal(
    mapPoePorts(VINGT_QUATRE_PORTS, HUIT_PRISES, { delivering: [], linkUp: [1, 2, 3] }),
    null,
  );
});

test('🔴 le switch dont les prises PoE sont bien les ports 1 à 8 est accepté', () => {
  // Trois caméras alimentées sur les prises 2, 5 et 7 ; les ports 2, 5 et 7 ont leur lien
  // actif, ce qui est cohérent. L'hypothèse tient.
  const mapping = mapPoePorts(VINGT_QUATRE_PORTS, HUIT_PRISES, {
    delivering: [{ group: 1, port: 2 }, { group: 1, port: 5 }, { group: 1, port: 7 }],
    linkUp: [2, 5, 7, 12, 20],
  });
  assert.ok(mapping, 'la correspondance doit être acceptée');
  assert.equal(mapping.strategy, 'identity');
  assert.deepEqual(mapping.byIfIndex.get(2), { group: 1, port: 2 });
});

test('🔴 le switch dont les prises PoE sont sur les ports 17 à 24 est refusé', () => {
  // Même table PoE que ci-dessus. Mais les caméras alimentées sont physiquement sur les
  // ports 18, 21 et 23 : les ports 2, 5 et 7 que l'hypothèse désigne sont éteints. Une
  // prise alimentée dont le port supposé est éteint dénonce la correspondance.
  assert.equal(
    mapPoePorts(VINGT_QUATRE_PORTS, HUIT_PRISES, {
      delivering: [{ group: 1, port: 2 }, { group: 1, port: 5 }, { group: 1, port: 7 }],
      linkUp: [18, 21, 23, 12, 20],
    }),
    null,
  );
});

test('🔴 une seule prise alimentée sur un port éteint suffit à refuser', () => {
  // Une correspondance partielle est exactement le cas où l'on croit avoir compris.
  assert.equal(
    mapPoePorts(VINGT_QUATRE_PORTS, HUIT_PRISES, {
      delivering: [{ group: 1, port: 2 }, { group: 1, port: 5 }],
      linkUp: [2, 12, 20],   // le port 5 est éteint alors que sa prise délivre
    }),
    null,
  );
});

test('autant de prises que de ports : l’hypothèse se referme, rien à corroborer', () => {
  // Chaque port a sa prise, sans doublon : c'est une bijection, aussi solide que
  // l'ordinal. Exiger une preuve ici priverait de PoE un switch entièrement PoE dont
  // rien n'est branché.
  const huitPorts = [1, 2, 3, 4, 5, 6, 7, 8];
  const mapping = mapPoePorts(huitPorts, HUIT_PRISES);
  assert.ok(mapping);
  assert.equal(mapping.strategy, 'identity');
});
