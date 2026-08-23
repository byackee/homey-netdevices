import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { planPoePower, planPortPower, type ControlContext } from '../../lib/netswitch/control.mjs';

const ALLOWED: ControlContext = { allowControl: true, ifIndex: 5, poe: { group: 1, port: 5 } };
const DEFAULT: ControlContext = { ...ALLOWED, allowControl: false };

test('🔴 par défaut, aucune écriture n\'est permise — ni sur le port, ni sur le PoE', () => {
  // C'est LA garantie du driver. Le réglage `allow_control` naît décoché, et un appareil
  // appairé avant qu'il existe n'en porte aucune valeur : le device le lit strictement
  // comme `=== true`, donc « absent » vaut « refusé ».
  const port = planPortPower(DEFAULT, false);
  assert.equal(port.allowed, false);
  assert.equal(port.allowed === false && port.reason, 'control-disabled');

  const poe = planPoePower(DEFAULT, false);
  assert.equal(poe.allowed, false);
  assert.equal(poe.allowed === false && poe.reason, 'control-disabled');
});

test('un refus ne porte AUCUN varbind : il n\'y a rien à émettre par erreur', () => {
  const decision = planPortPower(DEFAULT, false);
  assert.equal('writes' in decision, false,
    'un refus qui porterait des varbinds pourrait être émis par un appelant distrait');
});

test('ifAdminStatus : up(1) / down(2), sur le bon index', () => {
  const on = planPortPower(ALLOWED, true);
  assert.ok(on.allowed);
  assert.deepEqual(on.allowed && on.writes, [{ oid: '1.3.6.1.2.1.2.2.1.7.5', type: 'integer', value: 1 }]);

  const off = planPortPower(ALLOWED, false);
  assert.deepEqual(off.allowed && off.writes, [{ oid: '1.3.6.1.2.1.2.2.1.7.5', type: 'integer', value: 2 }]);
});

test('🔴 pethPsePortAdminEnable est un TruthValue : true(1) / false(2), et jamais 0', () => {
  const on = planPoePower(ALLOWED, true);
  assert.deepEqual(on.allowed && on.writes, [{ oid: '1.3.6.1.2.1.105.1.1.1.3.1.5', type: 'integer', value: 1 }]);

  const off = planPoePower(ALLOWED, false);
  assert.deepEqual(off.allowed && off.writes, [{ oid: '1.3.6.1.2.1.105.1.1.1.3.1.5', type: 'integer', value: 2 }]);
});

test('l\'OID PoE porte les deux index {groupe, port}, pas le seul numéro de port', () => {
  const decision = planPoePower({ ...ALLOWED, poe: { group: 2, port: 13 } }, true);
  assert.equal(decision.allowed && decision.writes[0]?.oid, '1.3.6.1.2.1.105.1.1.1.3.2.13');
});

test('🔴 sans correspondance PoE, on ne vise pas au jugé', () => {
  const decision = planPoePower({ ...ALLOWED, poe: null }, false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.reason, 'no-poe');
});

test('🔴 un port dont l\'index est perdu ne reçoit rien', () => {
  // Écrire sur l'index mémorisé après une renumérotation couperait le port voisin — sur
  // un switch domestique, potentiellement celui qui alimente le Homey.
  const decision = planPortPower({ ...ALLOWED, ifIndex: null }, false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.reason, 'no-port');
});

test('couper le port et couper le PoE sont deux commandes distinctes', () => {
  // Les confondre sous un seul bouton serait un piège : redémarrer une caméra ne devrait
  // pas désactiver la configuration du port.
  const port = planPortPower(ALLOWED, false);
  const poe = planPoePower(ALLOWED, false);
  assert.notEqual(port.allowed && port.writes[0]?.oid, poe.allowed && poe.writes[0]?.oid);
});
