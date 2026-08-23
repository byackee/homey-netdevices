import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { portLabel, resolvePortIndex, type PortIdentity } from '../../lib/netswitch/port.mjs';

function port(ifIndex: number, name: string | null, description: string | null = null): PortIdentity {
  return { ifIndex, name, description, alias: null, type: 6 };
}

const INVENTORY = [port(1, 'Gi1/0/1'), port(2, 'Gi1/0/2'), port(3, 'Gi1/0/3')];

test('le cas courant : l\'index mémorisé porte toujours le même nom', () => {
  assert.equal(resolvePortIndex(INVENTORY, { ifIndex: 2, name: 'Gi1/0/2', description: null }), 2);
});

test('🔴 un switch qui renumérote ne fait pas relever le port voisin', () => {
  // Le symptôme est muet : les courbes ne s'arrêtent pas, elles deviennent fausses.
  const renumbered = [port(11, 'Gi1/0/1'), port(12, 'Gi1/0/2'), port(13, 'Gi1/0/3')];
  assert.equal(resolvePortIndex(renumbered, { ifIndex: 2, name: 'Gi1/0/2', description: null }), 12);
});

test('🔴 un port disparu rend null, jamais l\'index mémorisé', () => {
  // Retomber sur l'index reviendrait à publier les mesures d'un autre port. Mieux vaut
  // un appareil qui se dit indisponible.
  assert.equal(resolvePortIndex(INVENTORY, { ifIndex: 2, name: 'Gi9/9/9', description: null }), null);
});

test('deux ports homonymes : l\'index mémorisé fait foi tant qu\'il porte le même nom', () => {
  // C'est ce que `disambiguate()` a décidé au pairing : quand deux ports portent le même
  // nom, l'ifIndex EST ce qui les sépare. Rendre null ici priverait ces appareils de tout
  // relevé alors que rien n'a bougé.
  const twins = [port(1, 'Port'), port(2, 'Port')];
  assert.equal(resolvePortIndex(twins, { ifIndex: 2, name: 'Port', description: null }), 2);
});

test('🔴 deux ports homonymes ET renumérotés sont indiscernables : on ne tire pas au sort', () => {
  // Une chance sur deux de relever le voisin n'est pas une correspondance.
  const twins = [port(11, 'Port'), port(12, 'Port')];
  assert.equal(resolvePortIndex(twins, { ifIndex: 2, name: 'Port', description: null }), null);
});

test('sans ifName, la description sert de clé', () => {
  const legacy = [port(1, null, 'FastEthernet0/1'), port(2, null, 'FastEthernet0/2')];
  assert.equal(resolvePortIndex(legacy, { ifIndex: 1, name: null, description: 'FastEthernet0/2' }), 2);
});

test('sans nom ni description mémorisés, seul l\'index existant reste', () => {
  assert.equal(resolvePortIndex(INVENTORY, { ifIndex: 3, name: null, description: null }), 3);
  assert.equal(resolvePortIndex(INVENTORY, { ifIndex: 9, name: null, description: null }), null);
});

test('portLabel préfère l\'étiquette écrite par l\'administrateur, sans perdre le nom du port', () => {
  assert.equal(portLabel({ ifIndex: 5, name: 'Gi1/0/5', description: 'GigabitEthernet1/0/5', alias: 'Caméra jardin', type: 6 }),
    'Gi1/0/5 — Caméra jardin');
  assert.equal(portLabel({ ifIndex: 5, name: 'Gi1/0/5', description: null, alias: null, type: 6 }), 'Gi1/0/5');
  assert.equal(portLabel({ ifIndex: 5, name: null, description: 'GigabitEthernet1/0/5', alias: null, type: 6 }),
    'GigabitEthernet1/0/5');
  assert.equal(portLabel({ ifIndex: 5, name: null, description: null, alias: null, type: 6 }), 'Port 5');
  assert.equal(portLabel({ ifIndex: 5, name: '  ', description: null, alias: '  ', type: 6 }), 'Port 5',
    'du blanc n\'est pas un nom');
});
