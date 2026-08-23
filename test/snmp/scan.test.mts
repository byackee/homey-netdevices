import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SnmpReader, SnmpValue } from '../../lib/snmp/client.mjs';
import { scanSubnet, subnetOf } from '../../lib/snmp/scan.mjs';

/**
 * Un client factice : le balayage n'ouvre jamais de socket dans ces tests.
 *
 * C'est précisément pour ça que `scanSubnet` prend une fabrique de client — un
 * balayage qui exigerait un vrai /24 ne serait jamais exécuté, donc ne prouverait rien.
 */
function fakeClient(host: string, answers: Map<string, SnmpValue> = new Map()): SnmpReader {
  return {
    host,
    get: async () => answers,
    walk: async () => new Map<string, SnmpValue>(),
  };
}

test('subnetOf tolère le port et refuse de deviner le reste', () => {
  assert.equal(subnetOf('192.168.50.251'), '192.168.50');
  assert.equal(subnetOf('192.168.50.251:80'), '192.168.50', 'forme rendue par getLocalAddress()');
  assert.equal(subnetOf(' 10.0.0.4 '), '10.0.0');
  assert.equal(subnetOf('fe80::1'), null, 'IPv6 : on ne devine pas');
  assert.equal(subnetOf('192.168.1'), null);
  assert.equal(subnetOf('192.168.1.999'), null);
  assert.equal(subnetOf(''), null);
});

test('la sonde est posée à chaque adresse du /24, .1 à .254', async () => {
  const asked: string[] = [];
  await scanSubnet<string>(
    '192.168.7',
    async (client) => { asked.push(client.host); return null; },
    { createClient: fakeClient },
  );

  assert.equal(asked.length, 254);
  const sorted = [...asked].sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]));
  assert.equal(sorted[0], '192.168.7.1');
  assert.equal(sorted[253], '192.168.7.254');
});

test('skip retire les adresses déjà appairées', async () => {
  const asked = new Set<string>();
  await scanSubnet<string>(
    '10.0.0',
    async (client) => { asked.add(client.host); return null; },
    { skip: new Set(['10.0.0.4', '10.0.0.9']), createClient: fakeClient },
  );

  assert.equal(asked.size, 252);
  assert.ok(!asked.has('10.0.0.4'));
  assert.ok(!asked.has('10.0.0.9'));
});

test('seules les réponses non nulles sortent, et triées par dernier octet', async () => {
  const cibles = new Map([['10.0.0.200', 'gros'], ['10.0.0.3', 'petit'], ['10.0.0.42', 'milieu']]);

  const found = await scanSubnet<{ host: string; nom: string }>(
    '10.0.0',
    async (client) => {
      const nom = cibles.get(client.host);
      // Un délai variable pour que l'ordre d'arrivée ne soit pas l'ordre d'adresse.
      if (nom !== undefined) await new Promise((r) => setTimeout(r, nom === 'gros' ? 0 : 15));
      return nom === undefined ? null : { host: client.host, nom };
    },
    { createClient: fakeClient },
  );

  assert.deepEqual(found.map((f) => f.host), ['10.0.0.3', '10.0.0.42', '10.0.0.200']);
});

test('la sonde décide seule de ce qui compte : le balayage ne présume rien de T', async () => {
  // Ici T est un simple nombre — pas d'objet, pas de champ `host` imposé.
  const found = await scanSubnet<number>(
    '172.16.3',
    async (client) => {
      const last = Number(client.host.split('.')[3]);
      return last % 100 === 0 ? last : null;
    },
    { createClient: fakeClient },
  );

  assert.deepEqual(found, [100, 200]);
});

test('onFound remonte au fil de l\'eau, avant la fin du balayage', async () => {
  const vus: string[] = [];
  const found = await scanSubnet<string>(
    '10.1.1',
    async (client) => (client.host === '10.1.1.5' || client.host === '10.1.1.6' ? client.host : null),
    { createClient: fakeClient, onFound: (value, host) => { vus.push(`${host}=${value}`); } },
  );

  assert.deepEqual(vus.sort(), ['10.1.1.5=10.1.1.5', '10.1.1.6=10.1.1.6']);
  assert.deepEqual(found, ['10.1.1.5', '10.1.1.6']);
});

test('un auditeur qui lève ne fait pas tomber le balayage qu\'il observe', async () => {
  const found = await scanSubnet<string>(
    '10.2.2',
    async (client) => (Number(client.host.split('.')[3]) <= 3 ? client.host : null),
    { createClient: fakeClient, onFound: () => { throw new Error('la vue a explosé'); } },
  );

  assert.deepEqual(found, ['10.2.2.1', '10.2.2.2', '10.2.2.3']);
});

test('une adresse injoignable n\'emporte pas les 253 autres', async () => {
  const found = await scanSubnet<string>(
    '10.3.3',
    async (client) => {
      const last = Number(client.host.split('.')[3]);
      if (last % 2 === 0) throw new Error(`Aucune réponse SNMP de ${client.host}`);
      return last === 7 ? client.host : null;
    },
    { createClient: fakeClient },
  );

  assert.deepEqual(found, ['10.3.3.7']);
});

test('la concurrence est plafonnée : chaque sonde tient un socket UDP', async () => {
  let enVol = 0;
  let maximum = 0;

  await scanSubnet<string>(
    '10.4.4',
    async () => {
      enVol += 1;
      maximum = Math.max(maximum, enVol);
      await new Promise((r) => setImmediate(r));
      enVol -= 1;
      return null;
    },
    { createClient: fakeClient, concurrency: 5 },
  );

  assert.equal(maximum, 5, 'jamais plus de sondes simultanées que demandé');
});

test('le plafond par défaut est celui éprouvé sur Homey, pas 254', async () => {
  let enVol = 0;
  let maximum = 0;

  await scanSubnet<string>(
    '10.5.5',
    async () => {
      enVol += 1;
      maximum = Math.max(maximum, enVol);
      await new Promise((r) => setImmediate(r));
      enVol -= 1;
      return null;
    },
    { createClient: fakeClient },
  );

  assert.equal(maximum, 24);
});

test('un /24 entièrement ignoré se termine sans rien sonder', async () => {
  const skip = new Set(Array.from({ length: 254 }, (_, i) => `10.6.6.${i + 1}`));
  let sondes = 0;

  const found = await scanSubnet<string>(
    '10.6.6',
    async () => { sondes += 1; return null; },
    { skip, createClient: fakeClient },
  );

  assert.equal(sondes, 0);
  assert.deepEqual(found, []);
});

test('la sonde reçoit un client capable de lire des OID', async () => {
  const réponse = new Map<string, SnmpValue>([['1.3.6.1.2.1.1.5.0', 'nas-salon']]);

  const found = await scanSubnet<string>(
    '10.7.7',
    async (client) => {
      const r = await client.get(['1.3.6.1.2.1.1.5.0']);
      const nom = r.get('1.3.6.1.2.1.1.5.0');
      return typeof nom === 'string' && client.host === '10.7.7.20' ? nom : null;
    },
    { createClient: (host) => fakeClient(host, réponse) },
  );

  assert.deepEqual(found, ['nas-salon']);
});
