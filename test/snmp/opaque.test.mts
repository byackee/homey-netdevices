import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decodeOpaqueFloat, toNumber } from '../../lib/snmp/opaque.mjs';

test('décode le vecteur canonique Net-SNMP : 123', () => {
  assert.equal(decodeOpaqueFloat(Buffer.from('9f780442f60000', 'hex')), 123);
});

test('décode une charge batterie fractionnaire', () => {
  const buffer = Buffer.alloc(7);
  buffer[0] = 0x9f; buffer[1] = 0x78; buffer[2] = 0x04;
  buffer.writeFloatBE(87.5, 3);
  assert.equal(decodeOpaqueFloat(buffer), 87.5);
});

test('décode un double Opaque', () => {
  const buffer = Buffer.alloc(11);
  buffer[0] = 0x9f; buffer[1] = 0x79; buffer[2] = 0x08;
  buffer.writeDoubleBE(12.25, 3);
  assert.equal(decodeOpaqueFloat(buffer), 12.25);
});

test('rend null sur un tampon qui n\'est pas un flottant Opaque', () => {
  assert.equal(decodeOpaqueFloat(Buffer.from('deadbeef', 'hex')), null);
  assert.equal(decodeOpaqueFloat(Buffer.alloc(0)), null);
  assert.equal(decodeOpaqueFloat(Buffer.from('9f780542f60000', 'hex')), null, 'longueur annoncée fausse');
});

test('toNumber préserve null plutôt que de rendre zéro', () => {
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(Buffer.from('deadbeef', 'hex')), null);
  assert.equal(toNumber('pas un nombre'), null);
});

test('toNumber accepte les trois formes que les agents emploient', () => {
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber('42'), 42);
  assert.equal(toNumber(Buffer.from('9f780442f60000', 'hex')), 123);
});
