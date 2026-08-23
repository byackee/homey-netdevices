import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  PAIRING_RESULT_KEYS,
  buildNasCandidate,
  offerHost,
  communityOf,
  dedupeByHost,
  hostOf,
  nasDeviceId,
  slug,
  suggestNasName,
  type NasCandidateInput,
} from '../../drivers/nas/pairing.mjs';
import type { CapabilityOptions } from '../../lib/nas/capability-map.mjs';

function input(overrides: Partial<NasCandidateInput> = {}): NasCandidateInput {
  return {
    host: '192.168.1.30',
    version: 'v2c',
    community: 'public',
    port: 161,
    mac: '00:11:32:AA:BB:CC',
    vendor: 'Synology',
    name: 'DiskStation',
    description: 'Linux DiskStation 4.4.302+',
    capabilities: ['nas_cpu_load', 'nas_uptime', 'nas_storage_used.volume1'],
    options: new Map<string, CapabilityOptions>([
      ['nas_storage_used.volume1', { title: { en: '/volume1', fr: '/volume1', nl: '/volume1' } }],
    ]),
    volumeCount: 1,
    takenIds: new Set<string>(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// La panne 6 : une clé en trop vide la liste, sans un mot
// ---------------------------------------------------------------------------

test('🔴 un candidat ne porte que les clés qu\'un résultat de pairing admet', () => {
  // Toute autre clé — `class`, par exemple, qui semble si naturelle — vide la liste
  // sans un mot : pas d'erreur, pas de log, et le SDK type ça `any[]` donc le
  // compilateur ne voit rien. C'est la panne n°6 du rétro.
  const { device } = buildNasCandidate(input());
  for (const key of Object.keys(device)) {
    assert.ok(
      (PAIRING_RESULT_KEYS as readonly string[]).includes(key),
      `clé interdite dans un résultat de pairing : ${key}`,
    );
  }
});

test('🔴 les capabilities partent dès le pairing, pas au premier relevé', () => {
  // C'est le correctif n°1 de la revue SDK, appliqué d'emblée : un appareil créé avec sa
  // liste complète affiche ses mesures à la seconde où il apparaît, au lieu d'une tuile
  // vide jusqu'au premier cycle lent.
  const { device } = buildNasCandidate(input());
  assert.deepEqual(device.capabilities, ['nas_cpu_load', 'nas_uptime', 'nas_storage_used.volume1']);
  assert.deepEqual(device.capabilitiesOptions, {
    'nas_storage_used.volume1': { title: { en: '/volume1', fr: '/volume1', nl: '/volume1' } },
  });
});

test('les réglages du candidat sont ceux avec lesquels l\'hôte a réellement répondu', () => {
  // Le défaut n°1 de la revue : le balayage écrivait `community: 'public'` en dur, si
  // bien qu'un appareil adopté sur une communauté personnalisée naissait muet.
  const { device } = buildNasCandidate(input({ community: 'privé', version: 'v1' }));
  assert.deepEqual(device.settings, { host: '192.168.1.30', community: 'privé', port: 161, version: 'v1' });
});

test('la MAC est mémorisée dans le store, pour qu\'une réinstallation la retrouve', () => {
  assert.deepEqual(buildNasCandidate(input()).device.store, { mac: '00:11:32:AA:BB:CC' });
});

// ---------------------------------------------------------------------------
// Offrir, ou ne pas offrir
// ---------------------------------------------------------------------------

test('🔴 un hôte dont aucune mesure n\'est lisible n\'est pas offert', () => {
  // Le créer donnerait un appareil sans une seule capability : Homey afficherait une
  // tuile vide, pour toujours, et l'utilisateur n'aurait aucun moyen de comprendre
  // pourquoi.
  const offer = offerHost(input({ capabilities: [], options: new Map(), volumeCount: 0 }));
  assert.equal(offer.candidate, null);
  assert.equal(offer.reason, 'nothing-readable');
});

test('« ne rend rien de lisible » est un verdict, pas une erreur', () => {
  // Un ESXi minimal, un agent bridé et un conteneur y ressemblent tous. La vue le
  // traduit par la marche à suivre, pas par « rien trouvé ».
  assert.doesNotThrow(() => offerHost(input({ capabilities: [], options: new Map() })));
});

test('une seule mesure lisible suffit à offrir l\'hôte', () => {
  const offer = offerHost(input({ capabilities: ['nas_uptime'], options: new Map(), volumeCount: 0 }));
  assert.equal(offer.reason, 'host');
  assert.deepEqual(offer.candidate?.device.capabilities, ['nas_uptime']);
});

// ---------------------------------------------------------------------------
// L'identité durable
// ---------------------------------------------------------------------------

test('🔴 l\'identifiant n\'est jamais l\'adresse tant qu\'il y a mieux', () => {
  // `data` est figé à la création : un identifiant bâti sur l'IP condamne l'appareil au
  // prochain bail DHCP, et la seule issue est de le supprimer et de le réappairer — en
  // perdant son historique Insights.
  assert.equal(nasDeviceId('00:11:32:AA:BB:CC', 'DiskStation', '192.168.1.30'), 'nas:mac:00-11-32-aa-bb-cc');
  assert.equal(nasDeviceId(null, 'DiskStation', '192.168.1.30'), 'nas:name:diskstation');
  assert.equal(nasDeviceId(null, null, '192.168.1.30'), 'nas:host:192.168.1.30');
});

test('la MAC donne le même identifiant quelle que soit sa casse ou son séparateur', () => {
  assert.equal(
    nasDeviceId('00-11-32-aa-bb-cc', null, '192.168.1.30'),
    nasDeviceId('00:11:32:AA:BB:CC', null, '192.168.1.30'),
  );
});

test('🔴 deux DiskStation sortis du carton ne se battent pas pour le même identifiant', () => {
  // Sans ce repli, le second candidat porterait l'identifiant du premier et la vue de
  // pairing le filtrerait comme « déjà appairé ». Il disparaîtrait de la liste sans un
  // message — très exactement la forme de panne que ce fichier existe pour empêcher.
  const first = nasDeviceId(null, 'DiskStation', '192.168.1.30');
  const second = nasDeviceId(null, 'DiskStation', '192.168.1.31', new Set([first]));

  assert.equal(first, 'nas:name:diskstation');
  assert.equal(second, 'nas:host:192.168.1.31');
  assert.notEqual(first, second);
});

test('🔴 une MAC déjà prise n\'est PAS repliée : c\'est le même appareil', () => {
  // Contrairement à un homonyme, deux hôtes ne partagent pas une MAC. Se replier ici
  // créerait un second appareil Homey pour une seule machine, dont un condamné à ne rien
  // lire.
  const id = nasDeviceId('00:11:32:AA:BB:CC', 'DiskStation', '192.168.1.30');
  assert.equal(nasDeviceId('00:11:32:AA:BB:CC', 'DiskStation', '192.168.1.31', new Set([id])), id);
});

test('slug rend une valeur d\'agent utilisable dans un identifiant', () => {
  assert.equal(slug('  DiskStation  '), 'diskstation');
  assert.equal(slug('NAS de Léa'), 'nas-de-l-a');
  assert.equal(slug('---'), '');
  assert.equal(slug(null), '');
});

// ---------------------------------------------------------------------------
// Le nom proposé
// ---------------------------------------------------------------------------

test('🔴 le nom part du sysName, à l\'inverse de l\'onduleur', () => {
  // Une carte d'onduleur publie un modèle utile et un `sysName` générique ; un hôte
  // publie un `sysDescr` illisible et un `sysName` que son propriétaire a choisi.
  assert.equal(suggestNasName('DiskStation', 'Synology', 'Linux DiskStation 4.4.302+', '192.168.1.30'),
    'Synology DiskStation');
});

test('la marque n\'est pas répétée quand le nom la porte déjà', () => {
  assert.equal(suggestNasName('Synology-NAS', 'Synology', null, '192.168.1.30'), 'Synology-NAS');
  assert.equal(suggestNasName('synology-nas', 'Synology', null, '192.168.1.30'), 'synology-nas');
});

test('sans nom, on prend ce qu\'il y a — et jamais rien', () => {
  assert.equal(suggestNasName(null, 'QNAP', 'Linux TS-453', '192.168.1.40'), 'QNAP (192.168.1.40)');
  assert.equal(suggestNasName(null, null, 'Linux srv01 5.15.0', '192.168.1.41'), 'Linux (192.168.1.41)');
  assert.equal(suggestNasName(null, null, null, '192.168.1.42'), 'Hôte (192.168.1.42)');
  assert.equal(suggestNasName('   ', null, '   ', '192.168.1.43'), 'Hôte (192.168.1.43)');
});

test('le sous-titre dit ce que l\'appareil portera vraiment', () => {
  const one = buildNasCandidate(input({ volumeCount: 1 }));
  const many = buildNasCandidate(input({ volumeCount: 3 }));
  assert.match(one.subtitle, /1 volume/);
  assert.match(many.subtitle, /3 volumes/);
  assert.match(one.subtitle, /192\.168\.1\.30/);
});

// ---------------------------------------------------------------------------

test('dedupeByHost garde le premier : deux chemins voient les mêmes machines', () => {
  // La découverte MAC et le balayage voient les mêmes appareils. Les offrir deux fois
  // ferait créer deux appareils Homey pour un seul hôte.
  const deduped = dedupeByHost([
    { host: '192.168.1.30', from: 'découverte' },
    { host: '192.168.1.31', from: 'balayage' },
    { host: '192.168.1.30', from: 'balayage' },
  ]);
  assert.deepEqual(deduped.map((entry) => entry.from), ['découverte', 'balayage']);
});

test('hostOf et communityOf nettoient ce que la vue envoie', () => {
  assert.equal(hostOf({ host: '  192.168.1.30 ' }), '192.168.1.30');
  assert.equal(hostOf(null), '');
  assert.equal(hostOf({}), '');
  assert.equal(communityOf({ community: ' privé ' }), 'privé');
  assert.equal(communityOf({ community: '   ' }), 'public', 'jamais une chaîne vide');
  assert.equal(communityOf(null), 'public');
});

test('le port sondé suit l\'appareil jusqu\'à ses réglages', () => {
  // Un hôte joignable au pairing puis interrogé sur 161 serait vu une fois et muet
  // ensuite. Faire suivre le port importe autant que de le proposer.
  const { device } = buildNasCandidate(input({ port: 1161 }));
  assert.equal(device.settings.port, 1161);
});
