import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  PAIRING_RESULT_KEYS,
  buildCandidate,
  communityOf,
  dedupeByHost,
  deviceId,
  hostOf,
  portOf,
  suggestName,
  type CandidateInput,
} from '../../drivers/ups/pairing.mjs';

/** Un candidat plausible, que chaque test dévie sur le seul point qui l'intéresse. */
function input(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    host: '192.168.1.20',
    source: 'apc',
    version: 'v2c',
    community: 'public',
    port: 161,
    mac: null,
    vendor: null,
    model: 'Smart-UPS 1500',
    manufacturer: 'APC',
    serial: 'AS1234567890',
    sysName: 'ups-garage',
    ...overrides,
  };
}

/**
 * 🔴 Le test que les trois apps précédentes n'avaient pas.
 *
 * Une clé en trop dans un résultat de pairing vide la liste **sans un mot** : pas
 * d'erreur, pas de log, un assistant qui ne propose rien. Le SDK type ces résultats
 * `any[]`, donc le compilateur ne dit rien non plus. C'est ici, et seulement ici, que ça
 * se voit avant du vrai matériel.
 */
test('un résultat de pairing ne porte que les clés que Homey admet', () => {
  const { device } = buildCandidate(input());
  const allowed = new Set<string>(PAIRING_RESULT_KEYS);

  for (const key of Object.keys(device)) {
    assert.ok(allowed.has(key), `clé interdite dans un résultat de pairing : ${key}`);
  }
  // `class` est celle qui semble la plus naturelle, et c'est celle qui a coûté une session.
  assert.equal(Object.hasOwn(device, 'class'), false);
  assert.deepEqual(Object.keys(device).sort(), ['data', 'name', 'settings', 'store']);
});

test('les réglages écrits au pairing sont ceux que le device relit', () => {
  const { device } = buildCandidate(input({ community: 'privé', version: 'v1' }));
  assert.deepEqual(device.settings, { host: '192.168.1.20', community: 'privé', port: 161, version: 'v1' });
  // La source va dans le `store` : le device la relit à l'init pour ne pas re-détecter.
  assert.equal(device.store.source, 'apc');
  assert.equal(device.store.serial, 'AS1234567890');
});

/**
 * 🔴 `data` est figé à la création : un identifiant bâti sur l'IP condamne l'appareil au
 * prochain bail DHCP, et la seule issue est de le supprimer — avec son historique.
 */
test('l’identité vient du numéro de série, pas de l’adresse', () => {
  const here = buildCandidate(input({ host: '192.168.1.20' })).device.data.id;
  const moved = buildCandidate(input({ host: '192.168.1.77' })).device.data.id;

  assert.equal(here, moved, 'le même onduleur à une autre adresse reste le même appareil');
  assert.ok(!here.includes('192.168'), `l’adresse ne doit pas entrer dans l’identité : ${here}`);
  assert.equal(here, 'apc:serial:as1234567890');
});

test('sans numéro de série, l’identité se rabat sur ce que l’agent publie', () => {
  const id = deviceId('rfc1628', null, 'Eaton 5PX', 'ups-cave', '192.168.1.20');
  assert.equal(id, 'rfc1628:id:eaton-5px-ups-cave');
  assert.ok(!id.includes('192.168'));

  // Série vide ou blanche : c'est une absence, pas une identité.
  assert.equal(deviceId('apc', '   ', 'Smart-UPS', null, '10.0.0.5'), 'apc:id:smart-ups');
});

test('un appareil qui ne publie rien d’identifiant se distingue par son adresse, faute de mieux', () => {
  const id = deviceId('synology', null, null, null, '192.168.1.20');
  assert.equal(id, 'synology:host:192.168.1.20', 'dernier recours assumé, pas un défaut');
});

test('deux sources sur la même machine restent deux appareils distincts', () => {
  // Un APC équipé d'une carte AP9631 répond à la RFC 1628 *et* à PowerNet : le dialecte
  // fait partie de l'identité, sinon adopter les deux écraserait le premier.
  assert.notEqual(
    deviceId('rfc1628', 'AS1234', null, null, '192.168.1.20'),
    deviceId('apc', 'AS1234', null, null, '192.168.1.20'),
  );
});

test('le nom proposé prend ce que l’agent publie, sans répéter la marque', () => {
  assert.equal(suggestName('5PX 1500', 'Eaton', null, '192.168.1.20'), 'Eaton 5PX 1500');
  // Le modèle porte déjà la marque : on ne l'écrit pas deux fois.
  assert.equal(suggestName('APC Smart-UPS 1500', 'APC', 'ups-garage', '192.168.1.20'), 'APC Smart-UPS 1500');
  assert.equal(suggestName(null, 'Eaton', 'ups-cave', '192.168.1.20'), 'Eaton');
  assert.equal(suggestName(null, null, 'ups-cave', '192.168.1.20'), 'ups-cave');
  assert.equal(suggestName(null, null, '   ', '192.168.1.20'), 'UPS (192.168.1.20)');
  assert.equal(suggestName('  ', null, null, '10.0.0.9'), 'UPS (10.0.0.9)');
});

test('le sous-titre dit où l’appareil est et d’où vient la lecture', () => {
  const relayed = buildCandidate(input({ source: 'synology', serial: null }));
  assert.equal(relayed.subtitle, '192.168.1.20 · relayed by a Synology NAS');

  const direct = buildCandidate(input({ source: 'rfc1628' }));
  assert.equal(direct.subtitle, '192.168.1.20 · nº AS1234567890 · RFC 1628');
});

test('la marque reconnue par l’OUI l’emporte sur celle que l’agent déclare', () => {
  // La MAC est connue avant toute lecture SNMP : c'est elle qui nomme un appareil dont
  // l'agent ne publie pas de constructeur.
  const candidate = buildCandidate(input({ vendor: 'APC / Schneider', manufacturer: null, model: null, sysName: null }));
  assert.equal(candidate.title, 'APC / Schneider');
  assert.equal(candidate.vendor, 'APC / Schneider');
});

test('la MAC découverte est mémorisée, et null quand le balayage l’a trouvé sans elle', () => {
  assert.equal(buildCandidate(input({ mac: '00:c0:b7:aa:bb:cc' })).device.store.mac, '00:c0:b7:aa:bb:cc');
  assert.equal(buildCandidate(input()).device.store.mac, null);
});

test('une adresse n’est offerte qu’une fois, découverte et balayage confondus', () => {
  const discovered = buildCandidate(input({ vendor: 'APC' }));
  const swept = buildCandidate(input({ vendor: null, model: null, sysName: null }));
  const other = buildCandidate(input({ host: '192.168.1.21', serial: 'ZZ9' }));

  const list = dedupeByHost([discovered, swept, other]);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.title, 'APC Smart-UPS 1500', 'la découverte, mieux nommée, garde la main');
  assert.equal(list[1]!.host, '192.168.1.21');
});

test('ce que la vue envoie est nettoyé avant d’être cru', () => {
  assert.equal(hostOf({ host: '  192.168.1.20  ' }), '192.168.1.20');
  assert.equal(hostOf({}), '');
  assert.equal(hostOf(null), '');
  assert.equal(hostOf(undefined), '');

  assert.equal(communityOf({ community: ' privé ' }), 'privé');
  assert.equal(communityOf({ community: '   ' }), 'public', 'une communauté vide n’est pas une communauté');
  assert.equal(communityOf({}), 'public');
  assert.equal(communityOf(null), 'public');
});

test('le port sondé est celui que le device relira', () => {
  // Un agent peut écouter ailleurs que sur 161 : un `snmpd` sans privilèges, un
  // conteneur, un simulateur. Le port qui a répondu au pairing doit suivre l'appareil,
  // faute de quoi il serait joignable une fois puis muet à jamais.
  const { device } = buildCandidate(input({ port: 1161 }));
  assert.equal(device.settings.port, 1161);
});

test('portOf retombe sur 161 plutôt que d\'échouer', () => {
  assert.equal(portOf({}), 161);
  assert.equal(portOf({ port: 'pas un nombre' }), 161);
  assert.equal(portOf({ port: 0 }), 161);
  assert.equal(portOf({ port: 70_000 }), 161);
  assert.equal(portOf({ port: 1161 }), 1161);
});
