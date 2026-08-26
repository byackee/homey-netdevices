import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TraceBuffer } from '../../lib/snmp/trace.mjs';

/** Horloge déterministe : un test ne doit pas dépendre de l'heure qu'il est. */
function fakeClock(start = 1_000): () => number {
  let t = start;
  return () => (t += 10);
}

test('le tampon est borné : la plus vieille entrée cède la place', () => {
  const buffer = new TraceBuffer({ capacity: 3, now: fakeClock() });
  for (const n of [1, 2, 3, 4, 5]) buffer.info('t', `message ${n}`);

  assert.equal(buffer.size, 3, 'trois entrées retenues, pas cinq');
  assert.equal(buffer.capacity, 3);
  assert.deepEqual(
    buffer.entries().map((e) => e.message),
    ['message 3', 'message 4', 'message 5'],
    'de la plus ancienne retenue à la plus récente',
  );
});

test('les entrées perdues sont comptées : une absence silencieuse serait pire que rien', () => {
  const buffer = new TraceBuffer({ capacity: 2, now: fakeClock() });
  assert.equal(buffer.dropped, 0);
  buffer.info('t', 'a');
  buffer.info('t', 'b');
  assert.equal(buffer.dropped, 0, 'plein mais rien de perdu');
  buffer.info('t', 'c');
  assert.equal(buffer.dropped, 1);
  assert.match(buffer.toText(), /1 older entry lost/);
});

test('avant débordement, les entrées sortent dans l\'ordre chronologique', () => {
  const buffer = new TraceBuffer({ capacity: 10, now: fakeClock(1_000) });
  buffer.debug('a', 'un');
  buffer.warn('b', 'deux');
  buffer.error('c', 'trois');

  const entries = buffer.entries();
  assert.deepEqual(entries.map((e) => [e.level, e.scope, e.message]), [
    ['debug', 'a', 'un'],
    ['warn', 'b', 'deux'],
    ['error', 'c', 'trois'],
  ]);
  assert.deepEqual(entries.map((e) => e.at), [1_010, 1_020, 1_030], 'horodatage à l\'insertion');
});

test('le détail est figé à l\'insertion, aucun objet applicatif n\'est retenu', () => {
  const buffer = new TraceBuffer({ capacity: 4, now: fakeClock() });
  const snapshot = { batterie: 87, statut: 'OL' };
  buffer.info('ups', 'relevé', snapshot);

  snapshot.batterie = 12;
  snapshot.statut = 'OB LB';

  const entry = buffer.entries()[0];
  assert.ok(entry);
  assert.equal(entry.detail, '{"batterie":87,"statut":"OL"}', 'la mutation ultérieure n\'atteint pas la trace');
});

test('entries() rend des copies : ce que sert GET /trace ne modifie pas le tampon', () => {
  const buffer = new TraceBuffer({ capacity: 4, now: fakeClock() });
  buffer.info('api', 'original');

  const first = buffer.entries()[0];
  assert.ok(first);
  first.message = 'saboté';

  assert.equal(buffer.entries()[0]?.message, 'original');
});

test('un détail impossible à sérialiser ne fait pas tomber ce qu\'il observe', () => {
  const buffer = new TraceBuffer({ capacity: 4, now: fakeClock() });

  const cyclique: { self?: unknown; nom: string } = { nom: 'boucle' };
  cyclique.self = cyclique;
  assert.doesNotThrow(() => buffer.info('t', 'cycle', cyclique));
  assert.match(String(buffer.entries()[0]?.detail), /<cycle>/);

  const explosif = { get piege(): never { throw new Error('boum'); } };
  assert.doesNotThrow(() => buffer.info('t', 'getter', explosif));
  assert.match(String(buffer.entries()[1]?.detail), /not serialisable/);

  buffer.info('t', 'bigint', { n: 42n });
  assert.match(String(buffer.entries()[2]?.detail), /42n/);

  buffer.info('t', 'octets', Buffer.from('9f7804', 'hex'));
  assert.match(String(buffer.entries()[3]?.detail), /9f7804/);
});

test('deux traces successives ne se signalent pas de faux cycles', () => {
  const buffer = new TraceBuffer({ capacity: 4, now: fakeClock() });
  const partagé = { hôte: '192.168.1.20' };

  buffer.info('t', 'un', { a: partagé });
  buffer.info('t', 'deux', { b: partagé });

  assert.equal(buffer.entries()[1]?.detail, '{"b":{"hôte":"192.168.1.20"}}');
});

test('une Error est réduite à son nom et son message', () => {
  const buffer = new TraceBuffer({ capacity: 2, now: fakeClock() });
  buffer.error('snmp', 'échec', new TypeError('adresse invalide'));
  assert.equal(buffer.entries()[0]?.detail, 'TypeError: adresse invalide');
});

test('un détail démesuré est tronqué : garder la référence coûterait la mémoire', () => {
  const buffer = new TraceBuffer({ capacity: 2, now: fakeClock() });
  buffer.info('t', 'gros', 'x'.repeat(5_000));

  const detail = buffer.entries()[0]?.detail ?? '';
  assert.equal(detail.length, 501, '500 caractères plus le marqueur de troncature');
  assert.ok(detail.endsWith('…'));
});

test('toText rend une ligne lisible par entrée', () => {
  const buffer = new TraceBuffer({ capacity: 4, now: () => Date.parse('2026-08-23T07:00:00.000Z') });
  buffer.warn('scan', 'aucune réponse', { hôte: '192.168.1.9' });

  assert.equal(
    buffer.toText(),
    '2026-08-23T07:00:00.000Z WARN  [scan] aucune réponse — {"hôte":"192.168.1.9"}',
  );
});

test('clear remet le tampon à zéro, compteur de pertes compris', () => {
  const buffer = new TraceBuffer({ capacity: 2, now: fakeClock() });
  buffer.info('t', 'a');
  buffer.info('t', 'b');
  buffer.info('t', 'c');
  assert.equal(buffer.dropped, 1);

  buffer.clear();
  assert.equal(buffer.size, 0);
  assert.equal(buffer.dropped, 0);
  assert.deepEqual(buffer.entries(), []);
  assert.equal(buffer.toText(), '');
});

test('une capacité absurde ne produit pas un tampon inutilisable', () => {
  const buffer = new TraceBuffer({ capacity: 0, now: fakeClock() });
  buffer.info('t', 'survit');
  assert.equal(buffer.capacity, 1);
  assert.equal(buffer.entries()[0]?.message, 'survit');
});
