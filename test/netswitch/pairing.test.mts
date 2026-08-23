import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  PAIRING_RESULT_KEYS, buildPortCandidate, disambiguate, duplicateIds, portDeviceId, slug,
  switchKeyOf, type PortCandidate, type PortCandidateInput,
} from '../../lib/netswitch/pairing.mjs';
import { PORTS_FOR_A_SWITCH } from '../../lib/netswitch/reader.mjs';
import type { PortIdentity } from '../../lib/netswitch/port.mjs';

function identity(ifIndex: number, name: string | null, description: string | null = null, alias: string | null = null): PortIdentity {
  return { ifIndex, name, description, alias, type: 6 };
}

function input(overrides: Partial<PortCandidateInput> = {}): PortCandidateInput {
  return {
    identity: identity(5, 'Gi1/0/5', 'GigabitEthernet1/0/5', 'Caméra jardin'),
    switchKey: 'serial:foc1234x5yz',
    switchName: 'sw-garage',
    host: '192.168.1.2',
    community: 'public',
    version: 'v2c',
    poe: { group: 1, port: 5 },
    capabilities: ['netswitch_link', 'netswitch_speed'],
    values: [],
    linkUp: true,
    speedMbps: 2_500,
    ...overrides,
  };
}

test('🔴 un résultat de pairing ne porte que les clés admises', () => {
  // Toute autre clé — `class`, `host`, `zone` — vide la liste SANS UN MOT : pas d'erreur,
  // pas de log, et le SDK type ça `any[]` donc le compilateur ne voit rien passer.
  const { device } = buildPortCandidate(input());
  for (const key of Object.keys(device)) {
    assert.ok(PAIRING_RESULT_KEYS.includes(key as never), `clé interdite dans le résultat : ${key}`);
  }
});

test('la charge utile porte tout ce que le device relira, et rien de plus', () => {
  const { device } = buildPortCandidate(input());
  assert.deepEqual(device.settings, { host: '192.168.1.2', community: 'public', version: 'v2c' });
  assert.deepEqual(device.store, {
    switchKey: 'serial:foc1234x5yz',
    ifIndex: 5,
    ifName: 'Gi1/0/5',
    ifDescr: 'GigabitEthernet1/0/5',
    poeGroup: 1,
    poePort: 5,
  });
  assert.deepEqual(device.capabilities, ['netswitch_link', 'netswitch_speed']);
});

test('🔴 onoff n\'est jamais dans la charge utile : l\'appareil naît sans commande', () => {
  // `allow_control` naît décoché ; c'est le driver qui bâtit les capabilities avec
  // `allowControl: false`, et ce test fixe l'attente côté pairing.
  const { device } = buildPortCandidate(input({ capabilities: ['netswitch_link', 'netswitch_speed'] }));
  assert.equal(device.capabilities.includes('onoff'), false);
});

test('🔴 l\'identifiant durable se bâtit sur le nom du port, jamais sur son index', () => {
  // `data` est figé à la création. Un identifiant bâti sur l'ifIndex condamne l'appareil
  // au premier redémarrage du switch qui renumérote — et la seule issue est de le
  // supprimer et de le réappairer, en perdant son historique Insights.
  const id = portDeviceId('serial:abc', identity(5, 'Gi1/0/5'));
  assert.equal(id, 'netswitch:serial:abc:port:gi1-0-5');
  assert.equal(id.includes(':index:'), false);
  // Le même port à un autre index garde le même identifiant : c'est tout l'objet.
  assert.equal(portDeviceId('serial:abc', identity(37, 'Gi1/0/5')), id);
});

test('sans ifName, la description sert ; sans elle non plus, l\'index est le dernier recours', () => {
  assert.equal(portDeviceId('name:sw', identity(3, null, 'FastEthernet0/3')),
    'netswitch:name:sw:port:fastethernet0-3');
  assert.equal(portDeviceId('name:sw', identity(3, null, null)), 'netswitch:name:sw:index:3');
});

test('l\'identité du switch préfère le série, puis le nom, puis l\'adresse', () => {
  assert.equal(switchKeyOf('FOC1234X5YZ', 'sw-garage', '192.168.1.2'), 'serial:foc1234x5yz');
  assert.equal(switchKeyOf(null, 'sw-garage', '192.168.1.2'), 'name:sw-garage');
  assert.equal(switchKeyOf(null, null, '192.168.1.2'), 'host:192.168.1.2');
  assert.equal(switchKeyOf('  ', '  ', '192.168.1.2'), 'host:192.168.1.2', 'du blanc n\'est pas une identité');
});

test('deux ports d\'un même switch reçoivent deux identifiants distincts', () => {
  const a = buildPortCandidate(input({ identity: identity(1, 'Gi1/0/1') }));
  const b = buildPortCandidate(input({ identity: identity(2, 'Gi1/0/2') }));
  assert.notEqual(a.device.data.id, b.device.data.id);
});

test('🔴 des noms de port en double sont détectés avant que la vue n\'adopte', () => {
  // Deux ports du même identifiant produiraient UN SEUL appareil : l'utilisateur en coche
  // vingt-quatre et en obtient vingt-trois, sans un mot. Ce pairing est le seul du dépôt
  // à créer plusieurs appareils, donc le seul où la panne existe.
  const twins: PortCandidate[] = [
    buildPortCandidate(input({ identity: identity(1, 'Port') })),
    buildPortCandidate(input({ identity: identity(2, 'Port') })),
  ];
  assert.equal(duplicateIds(twins).length, 1);

  const fixed = disambiguate(twins);
  assert.deepEqual(duplicateIds(fixed), [], 'la désambiguïsation doit résoudre la collision');
  assert.notEqual(fixed[0]?.id, fixed[1]?.id);
  assert.equal(fixed[0]?.id, fixed[0]?.device.data.id, 'la ligne et la charge utile restent d\'accord');
});

test('la désambiguïsation ne touche QUE les ports en collision', () => {
  const candidates = [
    buildPortCandidate(input({ identity: identity(1, 'Port') })),
    buildPortCandidate(input({ identity: identity(2, 'Port') })),
    buildPortCandidate(input({ identity: identity(3, 'Gi1/0/3') })),
  ];
  const fixed = disambiguate(candidates);
  assert.equal(fixed[2]?.id, candidates[2]?.id, 'un port sans homonyme garde son identifiant stable');
});

test('le nom proposé groupe les ports d\'un même switch dans la liste des appareils', () => {
  const candidate = buildPortCandidate(input());
  assert.equal(candidate.device.name, 'sw-garage · Gi1/0/5 — Caméra jardin');
  assert.equal(buildPortCandidate(input({ switchName: null })).device.name, 'Gi1/0/5 — Caméra jardin');
});

test('la ligne de détail dit ce qui aide à reconnaître le bon port', () => {
  const candidate = buildPortCandidate(input());
  assert.match(candidate.detail, /link up/);
  assert.match(candidate.detail, /2500 Mbit\/s/);
  assert.match(candidate.detail, /PoE 1\/5/);

  const dark = buildPortCandidate(input({ linkUp: false, speedMbps: 0, poe: null }));
  assert.match(dark.detail, /link down/);
  assert.equal(dark.detail.includes('PoE'), false);
  assert.equal(dark.detail.includes('0 Mbit/s'), false, 'un débit nul n\'apprend rien');
});

test('slug réduit ce qu\'un agent rend à quelque chose d\'utilisable', () => {
  assert.equal(slug('Gi1/0/5'), 'gi1-0-5');
  assert.equal(slug('  FOC1234X5YZ  '), 'foc1234x5yz');
  assert.equal(slug('---'), '');
  assert.equal(slug(null), '');
});

// ---------------------------------------------------------------------------
// Ce qui n'a qu'une interface n'est pas un switch.
// ---------------------------------------------------------------------------

test('🔴 une imprimante ne doit pas être proposée comme switch', () => {
  // Mesuré sur l'Epson XP-6100 du réseau de test : elle répond en SNMP, publie
  // `ifNumber = 1`, et apparaissait dans la première liste du pairing switch parce que
  // `looksLikeSwitch` n'intervenait qu'à l'étape suivante — après que l'utilisateur
  // l'ait déjà choisie.
  const listed = (interfaces: number | null) =>
    interfaces === null || interfaces >= PORTS_FOR_A_SWITCH;

  assert.equal(listed(1), false, 'une imprimante a une interface');
  assert.equal(listed(2), false, 'un NAS bi-port non plus');
  assert.equal(listed(PORTS_FOR_A_SWITCH), true);
  assert.equal(listed(48), true, 'un switch de baie');
});

test('un agent muet sur ifNumber reste listé : il n\'a pas dit non', () => {
  // `null` n'est pas zéro. Un firmware ancien qui ne publie pas `ifNumber` serait
  // exclu à tort, et c'est justement le genre d'appareil qu'on cherche à adopter.
  const listed = (interfaces: number | null) =>
    interfaces === null || interfaces >= PORTS_FOR_A_SWITCH;
  assert.equal(listed(null), true);
});

// ---------------------------------------------------------------------------
// La classe de l'appareil, et pourquoi elle reste `other`.
// ---------------------------------------------------------------------------

test('🔴 un port reste en class « other », jamais « socket »', () => {
  // La classe décide de l'inclusion dans les Flow cards de zone : un appareil `socket`
  // portant `onoff` est balayé par « éteins toutes les prises de cette pièce ». Pour un
  // port PoE, ce serait un piège — ce port alimente peut-être le point d'accès, la
  // caméra, ou le Homey lui-même, et l'utilisateur qui éteint son bureau ne demande pas
  // à couper sa supervision.
  //
  // `other` l'exclut de ces balayages. C'est délibéré, pas un oubli : ce test existe
  // pour que personne ne « corrige » la classe en croyant bien faire.
  const manifest = JSON.parse(
    readFileSync(`${process.cwd()}/drivers/netswitch/driver.compose.json`, 'utf8'),
  ) as { class?: string };
  assert.equal(manifest.class, 'other',
    'passer un port en socket l\'exposerait aux Flow cards de zone « tout éteindre »');
});
