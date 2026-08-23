import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

import {
  UPS_OUI,
  formatOui,
  macPrefixes,
  normaliseMac,
  ouiOf,
  vendorForMac,
} from '../../lib/snmp/oui.mjs';

/**
 * Le JSON de découverte, lu depuis la racine du dépôt.
 *
 * Résolu depuis l'URL du module compilé plutôt que depuis `process.cwd()` : le test doit
 * dire la vérité quel que soit l'endroit d'où `node --test` est lancé. Le compilé vit
 * dans `.testbuild/test/snmp/`, donc la racine est quatre niveaux au-dessus.
 */
function discoveryStrategy(): { type?: string; mac?: { manufacturer?: number[][] } } {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../../.homeycompose/discovery/ups.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { type?: string; mac?: { manufacturer?: number[][] } };
}

test('chaque préfixe est bien trois octets, et un seul constructeur le porte', () => {
  assert.ok(UPS_OUI.length > 0);

  for (const entry of UPS_OUI) {
    assert.equal(entry.prefix.length, 3, `${entry.vendor} : un OUI fait trois octets`);
    for (const byte of entry.prefix) {
      assert.ok(Number.isInteger(byte), `${entry.vendor} : ${byte} n'est pas un entier`);
      assert.ok(byte >= 0 && byte <= 255, `${entry.vendor} : ${byte} hors de 0–255`);
    }
    assert.notEqual(entry.registrant.trim(), '', 'le nom déposé rend l’entrée re-vérifiable');
    assert.notEqual(entry.vendor.trim(), '', 'la marque est ce que l’utilisateur reconnaît');
  }

  const seen = UPS_OUI.map((entry) => formatOui(entry.prefix));
  assert.equal(new Set(seen).size, seen.length, `préfixe en double : ${seen.join(' ')}`);
});

test('les préfixes couvrent les constructeurs que le plan nomme', () => {
  const vendors = UPS_OUI.map((entry) => entry.vendor.toLowerCase()).join(' ');
  for (const expected of ['apc', 'eaton', 'synology', 'qnap', 'cyberpower', 'riello', 'socomec', 'vertiv']) {
    assert.ok(vendors.includes(expected), `aucun préfixe pour ${expected}`);
  }
});

/**
 * 🔴 Le test qui compte.
 *
 * La stratégie `mac` veut les octets en **décimal**. Un préfixe recopié en hexadécimal y
 * est silencieusement faux : Homey ne rejette rien, la découverte ne trouve simplement
 * jamais rien. Rien d'autre — ni `npm test`, ni `homey app validate` — ne regarde ces
 * chiffres, donc c'est ici que les deux listes doivent être confrontées.
 */
test('le JSON de découverte dit exactement ce que dit la liste', () => {
  const strategy = discoveryStrategy();

  assert.equal(strategy.type, 'mac', 'un onduleur n’annonce rien : mac est la seule stratégie possible');

  const declared = strategy.mac?.manufacturer;
  assert.ok(Array.isArray(declared), 'la stratégie mac doit porter une liste de préfixes');
  assert.deepEqual(declared, macPrefixes(), 'le JSON et lib/snmp/oui.mts ont divergé');

  // La forme décimale se vérifie en la relisant : 00:C0:B7 vaut 0,192,183 — pas 0,C0,B7,
  // qui ne serait pas du JSON, ni 0,192,181, qui serait une autre société.
  assert.deepEqual(declared[0], [0, 192, 183], 'APC, 00:C0:B7');
  assert.equal(formatOui(UPS_OUI[0]!.prefix), '00:C0:B7');
});

test('macPrefixes() rend une copie : le test de divergence ne peut pas se comparer à lui-même', () => {
  const first = macPrefixes();
  first[0]![0] = 42;
  assert.notEqual(macPrefixes()[0]![0], 42);
  assert.equal(UPS_OUI[0]!.prefix[0], 0);
});

test('une MAC est reconnue quels que soient la casse et le séparateur', () => {
  assert.equal(normaliseMac('00:C0:B7:AA:BB:CC'), '00c0b7aabbcc');
  assert.equal(normaliseMac('00-c0-b7-aa-bb-cc'), '00c0b7aabbcc');
  assert.equal(normaliseMac('00c0.b7aa.bbcc'), '00c0b7aabbcc');
  assert.equal(normaliseMac(' 00C0B7AABBCC '), '00c0b7aabbcc');

  assert.deepEqual(ouiOf('00:11:32:01:02:03'), [0, 17, 50], 'Synology');
  assert.deepEqual(ouiOf('00c0b7'), [0, 192, 183], 'un préfixe seul suffit');
});

test('ce qui n’est pas une MAC rend null, plutôt qu’un constructeur au hasard', () => {
  assert.equal(normaliseMac(''), null);
  assert.equal(normaliseMac('00:c0'), null, 'moins de trois octets');
  assert.equal(normaliseMac('zz:c0:b7:aa:bb:cc'), null);
  assert.equal(normaliseMac('192.168.1.20'), null, 'une IP n’est pas une MAC');
  assert.equal(normaliseMac('00c0b7aabbc'), null, 'nombre impair de caractères');
  assert.equal(ouiOf('pas une mac'), null);
  assert.equal(vendorForMac(''), null);
});

test('vendorForMac nomme la marque, et ne nomme rien quand elle est inconnue', () => {
  assert.equal(vendorForMac('00:C0:B7:12:34:56'), 'APC');
  assert.equal(vendorForMac('28:29:86:00:00:01'), 'APC / Schneider');
  assert.equal(vendorForMac('00:11:32:aa:bb:cc'), 'Synology');
  assert.equal(vendorForMac('90:09:d0:aa:bb:cc'), 'Synology', 'bloc récent');
  assert.equal(vendorForMac('00:09:f5:aa:bb:cc'), 'Vertiv / Liebert', 'déposé sous Emerson');
  assert.equal(vendorForMac('00:02:63:aa:bb:cc'), 'Riello', 'déposé sous RPS S.p.A.');

  // Un préfixe Apple : la liste ne doit pas prétendre reconnaître le réseau entier.
  assert.equal(vendorForMac('00:1b:63:aa:bb:cc'), null);
});

test('formatOui rend la forme qu’on relit dans le registre IEEE', () => {
  assert.equal(formatOui([0, 192, 183]), '00:C0:B7');
  assert.equal(formatOui([144, 9, 208]), '90:09:D0');
});
