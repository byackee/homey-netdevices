import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  IF_SPEED_CEILING, adminUpOf, isPhysicalPort, linkStateOf, speedMbps,
} from '../../lib/netswitch/if-mib.mjs';
import {
  poeEnabledOf, poeRefFromOid, poeStatusOf, truthValue, PETH_PORT_TABLE, PETH_MAIN_TABLE,
} from '../../lib/netswitch/poe-mib.mjs';
import { indexOf } from '../../lib/netswitch/reader.mjs';

test('🔴 les fixtures de débit distinguent bien les conversions candidates', () => {
  // Garde-fou sur les tests eux-mêmes (plan §8.5) : avec une valeur mal choisie,
  // « diviser par un million » et « ne rien faire » donnent le même résultat, la suite
  // passe au vert, et le facteur part en production. 1 Gbit/s est précisément le
  // mauvais choix — 1e9 bit/s font 1000 Mbit/s, et 1000 est aussi ce que rend
  // `ifHighSpeed`, donc les deux lectures y sont indiscernables.
  assert.equal(new Set([2_500_000_000, 2_500_000_000 / 1_000_000, 2_500_000_000 / 1_000]).size, 3);
  assert.equal(new Set([1_000_000_000, 1_000_000_000 / 1_000_000]).size, 2);
  // Et le piège inverse : à 1 Gbit/s, préférer `ifHighSpeed` ou convertir `ifSpeed`
  // donne le MÊME nombre. Une fixture à ce débit ne prouverait donc rien sur la priorité.
  assert.equal(speedMbps(1_000, 1_000_000_000), speedMbps(null, 1_000_000_000));
});

test('speedMbps préfère ifHighSpeed, qui est la seule lecture juste au-delà du plafond', () => {
  // Un port 10G : `ifSpeed` est un Gauge32 et bute sur 4 294 967 295, soit ~4,29 Gbit/s.
  assert.equal(speedMbps(10_000, IF_SPEED_CEILING), 10_000, 'ifHighSpeed passe devant');
  assert.notEqual(speedMbps(10_000, IF_SPEED_CEILING), 4_295, 'le plafond ne doit pas gagner');
  // Et sans ifHighSpeed, on rend honnêtement ce que le plafond dit — pas 10 000.
  assert.equal(speedMbps(null, IF_SPEED_CEILING), 4_295);
});

test('speedMbps convertit des bit/s en Mbit/s, pas en kbit/s', () => {
  assert.equal(speedMbps(null, 2_500_000_000), 2_500);
  assert.notEqual(speedMbps(null, 2_500_000_000), 2_500_000, 'ce ne sont pas des kbit/s');
  assert.notEqual(speedMbps(null, 2_500_000_000), 2_500_000_000, 'ce ne sont pas déjà des Mbit/s');
});

test('speedMbps garde le zéro : un lien qui n\'a pas négocié est une mesure, pas une absence', () => {
  assert.equal(speedMbps(0, 0), 0);
  assert.equal(speedMbps(null, 0), 0);
});

test('speedMbps refuse ce qui n\'est pas un nombre exploitable', () => {
  assert.equal(speedMbps(null, null), null);
  assert.equal(speedMbps(null, Number.NaN), null);
  assert.equal(speedMbps(Number.NaN, null), null);
  assert.equal(speedMbps(null, -1), null, 'un débit négatif n\'existe pas');
});

test('linkStateOf transcrit les sept valeurs de ifOperStatus, et rien d\'autre', () => {
  assert.equal(linkStateOf(1), 'up');
  assert.equal(linkStateOf(2), 'down');
  assert.equal(linkStateOf(3), 'testing');
  assert.equal(linkStateOf(4), 'unknown');
  assert.equal(linkStateOf(5), 'dormant');
  assert.equal(linkStateOf(6), 'notPresent');
  assert.equal(linkStateOf(7), 'lowerLayerDown');
});

test('🔴 une valeur de lien illisible devient « unknown », jamais « down »', () => {
  // Le repli compte : « je ne sais pas » et « le câble est débranché » n'envoient pas
  // l'utilisateur au même endroit, et le second déclenche des Flows.
  assert.equal(linkStateOf(null), 'unknown');
  assert.equal(linkStateOf(99), 'unknown');
  assert.notEqual(linkStateOf(null), 'down');
});

test('adminUpOf ne tranche pas sur testing(3)', () => {
  assert.equal(adminUpOf(1), true);
  assert.equal(adminUpOf(2), false);
  assert.equal(adminUpOf(3), null, 'testing n\'est ni allumé ni éteint');
  assert.equal(adminUpOf(null), null);
});

test('isPhysicalPort écarte les interfaces qui ne sont pas des prises', () => {
  assert.equal(isPhysicalPort(6), true, 'ethernetCsmacd');
  assert.equal(isPhysicalPort(117), true, 'gigabitEthernet');
  assert.equal(isPhysicalPort(24), false, 'softwareLoopback');
  assert.equal(isPhysicalPort(53), false, 'propVirtual — un VLAN');
  assert.equal(isPhysicalPort(161), false, 'ieee8023adLag — un agrégat, pas une prise');
  assert.equal(isPhysicalPort(null), false);
});

test('poeStatusOf transcrit les six valeurs de RFC 3621', () => {
  assert.equal(poeStatusOf(1), 'disabled');
  assert.equal(poeStatusOf(2), 'searching');
  assert.equal(poeStatusOf(3), 'delivering');
  assert.equal(poeStatusOf(4), 'fault');
  assert.equal(poeStatusOf(5), 'test');
  assert.equal(poeStatusOf(6), 'otherFault');
  assert.equal(poeStatusOf(null), 'unknown');
  assert.notEqual(poeStatusOf(null), 'disabled', '« inconnu » n\'est pas « désactivé »');
});

test('🔴 le TruthValue de SNMPv2 est true(1)/false(2), pas 1/0', () => {
  // C'est l'inverse de l'intuition, et l'erreur est silencieuse : écrire 0 sur un
  // TruthValue est refusé par l'agent, ou pire, accepté et interprété autrement.
  assert.equal(truthValue(true), 1);
  assert.equal(truthValue(false), 2);
  assert.notEqual(truthValue(false), 0);
  assert.equal(poeEnabledOf(1), true);
  assert.equal(poeEnabledOf(2), false);
  assert.equal(poeEnabledOf(0), null, 'zéro n\'est pas une valeur de TruthValue');
  assert.equal(poeEnabledOf(null), null);
});

test('⚠️ pethMainPseTable est sous pethObjects.3.1, pas sous powerEthernetMIB.3', () => {
  // L'annexe §3 signale que beaucoup de résumés se trompent là-dessus, et l'erreur est
  // muette : la mauvaise branche rend null pour toujours, comme un switch sans PoE.
  assert.equal(PETH_MAIN_TABLE.consumptionPower, '1.3.6.1.2.1.105.1.3.1.1.4');
  assert.ok(!PETH_MAIN_TABLE.consumptionPower.startsWith('1.3.6.1.2.1.105.3.'),
    'powerEthernetMIB.3 est la mauvaise branche');
  assert.equal(PETH_PORT_TABLE.adminEnable, '1.3.6.1.2.1.105.1.1.1.3');
  assert.equal(PETH_PORT_TABLE.detectionStatus, '1.3.6.1.2.1.105.1.1.1.6');
});

test('poeRefFromOid exige exactement deux sous-identifiants : {groupe, port}', () => {
  const column = PETH_PORT_TABLE.detectionStatus;
  assert.deepEqual(poeRefFromOid(column, `${column}.1.5`), { group: 1, port: 5 });
  assert.deepEqual(poeRefFromOid(column, `${column}.2.24`), { group: 2, port: 24 });
  assert.equal(poeRefFromOid(column, `${column}.5`), null, 'un seul index n\'est pas cette table');
  assert.equal(poeRefFromOid(column, `${column}.1.2.3`), null, 'trois index non plus');
  assert.equal(poeRefFromOid(column, '1.3.6.1.2.1.2.2.1.8.5'), null, 'une autre branche');
});

test('indexOf n\'accepte que le suffixe entier d\'une colonne indexée par ifIndex', () => {
  assert.equal(indexOf('1.3.6.1.2.1.2.2.1.2', '1.3.6.1.2.1.2.2.1.2.7'), 7);
  assert.equal(indexOf('1.3.6.1.2.1.2.2.1.2', '1.3.6.1.2.1.2.2.1.2.1.7'), null);
  assert.equal(indexOf('1.3.6.1.2.1.2.2.1.2', '1.3.6.1.2.1.2.2.1.20.7'), null,
    'ifOutErrors commence par les mêmes chiffres qu\'ifDescr — le point sépare');
});
