import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  nasCapabilityValues,
  planNasCapabilities,
  storageCapabilityId,
  volumeKeyOf,
} from '../../lib/nas/capability-map.mjs';
import type { NasSnapshot } from '../../lib/nas/snapshot.mjs';

/** Un hôte qui publie tout ce que la MIB sait rendre, avec des valeurs discernables. */
const FULL: NasSnapshot = {
  name: 'DiskStation',
  description: 'Linux DiskStation 4.4.302+',
  uptimeDays: 1.5,
  cpuLoad: 28.5,
  cpuCount: 4,
  memoryUsedPercent: 85,
  temperature: 55,
  memoryIndex: 1,
  rejected: [],
  volumes: [
    { key: 'root', label: '/', usedPercent: 50, sizeBytes: 24_576_000_000, usedBytes: 12_288_000_000 },
    { key: 'volume1', label: '/volume1', usedPercent: 70, sizeBytes: 17_592_186_044_416, usedBytes: 12_314_530_230_272 },
    { key: 'mnt_backup', label: '/mnt/backup', usedPercent: 10, sizeBytes: 4_096_000_000, usedBytes: 409_600_000 },
  ],
};

/** Le même hôte, mais dépouillé : un ESXi sans capteurs ni table de processeurs. */
const SPARSE: NasSnapshot = {
  ...FULL,
  cpuLoad: null,
  cpuCount: 0,
  memoryUsedPercent: null,
  temperature: null,
  volumes: [{ key: 'datastore1', label: '/vmfs/volumes/datastore1', usedPercent: 62, sizeBytes: null, usedBytes: null }],
};

test('🔴 les fixtures de ce fichier sont discernables', () => {
  // Garde-fou du §8.5 : si deux mesures partageaient une valeur, une capability écrite à
  // la place d'une autre passerait au vert.
  const values = [FULL.cpuLoad, FULL.memoryUsedPercent, FULL.temperature, FULL.uptimeDays,
    ...FULL.volumes.map((volume) => volume.usedPercent)];
  assert.equal(new Set(values).size, values.length, `des valeurs convergent : ${values.join(', ')}`);
});

// ---------------------------------------------------------------------------

test('un hôte complet publie chacune de ses mesures', () => {
  const plan = planNasCapabilities(FULL);
  assert.deepEqual(plan.capabilities, [
    'nas_cpu_load',
    'nas_memory_used',
    'measure_temperature',
    'nas_uptime',
    'nas_storage_used.root',
    'nas_storage_used.volume1',
    'nas_storage_used.mnt_backup',
  ]);
});

test('les valeurs du plan suivent ses capabilities, dans le même ordre', () => {
  const plan = planNasCapabilities(FULL);
  assert.deepEqual(plan.values.map((entry) => entry.id), plan.capabilities);
  assert.deepEqual(plan.values.map((entry) => entry.value), [28.5, 85, 55, 1.5, 50, 70, 10]);
});

test('🔴 une mesure absente n\'est pas déclarée — et surtout pas déclarée à zéro', () => {
  // `removeCapability` détruit l'historique Insights de façon irréversible : une
  // capability déclarée « pour plus tard » est une capability qu'on ne peut plus retirer.
  const plan = planNasCapabilities(SPARSE);
  assert.deepEqual(plan.capabilities, ['nas_uptime', 'nas_storage_used.datastore1']);
  assert.ok(!plan.capabilities.includes('nas_cpu_load'));
  assert.ok(!plan.capabilities.includes('measure_temperature'));
  assert.deepEqual(
    plan.omitted.map((entry) => entry.id).sort(),
    ['measure_temperature', 'nas_cpu_load', 'nas_memory_used'],
  );
});

test('🔴 chaque volume reçoit son titre : Homey n\'en génère aucun pour une sous-capability', () => {
  // Sans eux, les trois volumes s'afficheraient tous « Storage used » — le même piège
  // que les trois tensions de l'onduleur.
  const plan = planNasCapabilities(FULL);
  assert.equal(plan.options.size, 3);
  assert.deepEqual(plan.options.get('nas_storage_used.volume1'),
    { title: { en: '/volume1', fr: '/volume1', nl: '/volume1' } });
  assert.deepEqual(plan.options.get('nas_storage_used.root'),
    { title: { en: '/', fr: '/', nl: '/' } });
});

test('les mesures scalaires ne reçoivent pas de titre : Homey en génère un', () => {
  const plan = planNasCapabilities(FULL);
  for (const id of ['nas_cpu_load', 'nas_memory_used', 'measure_temperature', 'nas_uptime']) {
    assert.ok(!plan.options.has(id), `${id} n'a pas besoin d'un titre posé à la main`);
  }
});

test('🔴 un hôte n\'a pas de batterie : energy reste null', () => {
  // Poser `energy` reviendrait à affirmer qu'un NAS est sur batterie, ce qui déplacerait
  // sa consommation dans le mauvais bilan énergétique de Homey.
  assert.equal(planNasCapabilities(FULL).energy, null);
});

test('un hôte dont rien n\'est lisible produit un plan vide, pas un plan de zéros', () => {
  // C'est ce qui permet au driver de refuser d'offrir un appareil qui ne montrerait
  // jamais rien.
  const plan = planNasCapabilities({
    ...FULL,
    uptimeDays: null, cpuLoad: null, cpuCount: 0, memoryUsedPercent: null,
    temperature: null, volumes: [],
  });
  assert.deepEqual(plan.capabilities, []);
  assert.deepEqual(plan.values, []);
});

test('un volume sans pourcentage n\'est pas déclaré', () => {
  const plan = planNasCapabilities({
    ...FULL,
    volumes: [{ key: 'cdrom', label: '/media/cdrom', usedPercent: null, sizeBytes: null, usedBytes: null }],
  });
  assert.ok(!plan.capabilities.includes('nas_storage_used.cdrom'));
  assert.deepEqual(plan.omitted, [{ id: 'nas_storage_used.cdrom', reason: 'no-value' }]);
});

// ---------------------------------------------------------------------------

test('nasCapabilityValues n\'écrit que sur ce que l\'appareil porte réellement', () => {
  const declared = ['nas_cpu_load', 'nas_storage_used.volume1'];
  assert.deepEqual(nasCapabilityValues(FULL, declared), [
    { id: 'nas_cpu_load', value: 28.5 },
    { id: 'nas_storage_used.volume1', value: 70 },
  ]);
});

test('🔴 un volume démonté reçoit null : ni zéro, ni sa dernière valeur', () => {
  // Zéro se lirait comme un disque vide. La dernière valeur donnerait une courbe plate à
  // 70 % pendant trois semaines, qui ressemble à un volume tranquille et non à un volume
  // absent.
  const unmounted: NasSnapshot = { ...FULL, volumes: FULL.volumes.slice(0, 1) };
  assert.deepEqual(nasCapabilityValues(unmounted, ['nas_storage_used.volume1']),
    [{ id: 'nas_storage_used.volume1', value: null }]);
});

test('🔴 une mesure qui disparaît reçoit null, la capability reste', () => {
  assert.deepEqual(nasCapabilityValues(SPARSE, ['nas_cpu_load', 'measure_temperature']), [
    { id: 'nas_cpu_load', value: null },
    { id: 'measure_temperature', value: null },
  ]);
});

test('une capability inconnue est ignorée sans erreur', () => {
  // Elle a pu être posée par une version antérieure de l'app, et on ne la retire pas.
  assert.deepEqual(nasCapabilityValues(FULL, ['une_capability_dune_autre_epoque']), []);
});

// ---------------------------------------------------------------------------

test('l\'identifiant de sous-capability et sa clé sont réversibles', () => {
  assert.equal(storageCapabilityId('volume1'), 'nas_storage_used.volume1');
  assert.equal(volumeKeyOf('nas_storage_used.volume1'), 'volume1');
  assert.equal(volumeKeyOf('nas_cpu_load'), null, 'une mesure scalaire n\'est pas un volume');
  assert.equal(volumeKeyOf('measure_temperature'), null);
});
