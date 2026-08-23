/**
 * 🔴 Le test qui interdit la régression la plus grave que la revue ait trouvée.
 *
 * Sur le driver onduleur, la carte des capabilities existait, elle était testée à fond,
 * et elle n'était **appelée de nulle part** : douze mesures sur treize étaient calculées
 * à chaque relevé puis jetées avant d'atteindre Homey. Ni `npm test` ni
 * `homey app validate` ne pouvaient le voir — la carte était verte en isolation, et
 * personne ne testait qu'on l'appelle.
 *
 * Ce fichier teste la jointure, pas la carte : que `planNasCapabilities` alimente
 * réellement `syncCapabilities`, et que ce que l'hôte a su lire finit sur un appareil.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { planNasCapabilities } from '../../lib/nas/capability-map.mjs';
import { syncCapabilities, type CapabilitySink } from '../../lib/ups/capability-sync.mjs';
import type { NasSnapshot } from '../../lib/nas/snapshot.mjs';

/**
 * Un double de `Homey.Device` réduit aux seuls effets qui nous intéressent.
 *
 * C'est ce que l'extraction achète : la vraie logique est exercée, pas une
 * réimplémentation. `drivers/nas/device.mts` ne peut pas être importé dans un test — le
 * paquet `homey` étant la CLI et non le SDK runtime.
 */
function sink(existing: string[] = []) {
  const state = {
    capabilities: [...existing],
    options: new Map<string, unknown>(),
    energy: null as unknown,
    energyCalls: 0,
    logs: [] as string[],
    errors: [] as string[],
    failOn: null as string | null,
  };
  const api: CapabilitySink = {
    listCapabilities: () => state.capabilities,
    addCapability: async (id) => {
      if (id === state.failOn) throw new Error('refusé par Homey');
      state.capabilities.push(id);
    },
    setCapabilityOptions: async (id, options) => { state.options.set(id, options); },
    setEnergy: async (energy) => { state.energy = energy; state.energyCalls += 1; },
    log: (m) => state.logs.push(m),
    error: (m) => state.errors.push(m),
  };
  return { state, api };
}

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
  ],
};

test('🔴 les mesures relevées finissent réellement en capabilities', async () => {
  // Le driver ne déclare que `nas_uptime` dans son manifeste. Sans cet appel, tout le
  // reste — la charge, la mémoire, la température, les deux volumes — serait calculé à
  // chaque relevé puis jeté avant d'atteindre Homey.
  const { state, api } = sink(['nas_uptime']);
  const result = await syncCapabilities(planNasCapabilities(FULL), api);

  assert.ok(result.added.length > 0, 'rien n\'a été ajouté : les mesures seraient jetées');
  assert.ok(state.capabilities.includes('nas_cpu_load'), 'la charge CPU doit être publiée');
  assert.ok(state.capabilities.includes('nas_memory_used'), 'la mémoire doit être publiée');
  assert.ok(state.capabilities.includes('measure_temperature'), 'la température doit être publiée');
  assert.ok(state.capabilities.includes('nas_storage_used.volume1'), 'les volumes doivent être publiés');
  assert.equal(state.capabilities.length, 6);
});

test('🔴 les volumes reçoivent leur titre, sinon ils s\'affichent tous pareil', async () => {
  const { state, api } = sink(['nas_uptime']);
  await syncCapabilities(planNasCapabilities(FULL), api);

  assert.deepEqual(state.options.get('nas_storage_used.volume1'),
    { title: { en: '/volume1', fr: '/volume1', nl: '/volume1' } });
  assert.deepEqual(state.options.get('nas_storage_used.root'),
    { title: { en: '/', fr: '/', nl: '/' } });
});

test('🔴 setEnergy n\'est jamais appelé : un NAS n\'est pas sur batterie', async () => {
  const { state, api } = sink(['nas_uptime']);
  await syncCapabilities(planNasCapabilities(FULL), api);
  assert.equal(state.energyCalls, 0);
  assert.equal(state.energy, null);
});

test('🔴 aucune capability n\'est jamais retirée, même sans source', async () => {
  // `removeCapability` détruit l'historique Insights de façon irréversible. Un volume
  // démonté cette semaine n'est pas un volume disparu.
  const { state, api } = sink(['nas_uptime', 'nas_storage_used.ancien_volume', 'une_capability_inconnue']);
  const result = await syncCapabilities(planNasCapabilities(FULL), api);

  assert.ok(state.capabilities.includes('nas_storage_used.ancien_volume'));
  assert.ok(state.capabilities.includes('une_capability_inconnue'));
  assert.deepEqual(result.orphaned.sort(), ['nas_storage_used.ancien_volume', 'une_capability_inconnue']);
});

test('🔴 l\'alignement est idempotent : un second appel n\'écrit rien', async () => {
  // C'est ce qui rend l'appel acceptable dans une boucle de relevé. Une écriture
  // persistante par tick serait un défaut en soi (plan §8.6) — netprinter réécrivait des
  // titres toutes les 300 s, et c'était déjà trop.
  const { api } = sink(['nas_uptime']);
  await syncCapabilities(planNasCapabilities(FULL), api);
  const second = await syncCapabilities(planNasCapabilities(FULL), api);

  assert.equal(second.changed, false, 'le second passage a réécrit quelque chose');
  assert.deepEqual(second.added, []);
});

test('un ajout refusé par Homey ne fait pas tomber les autres', async () => {
  const { state, api } = sink(['nas_uptime']);
  state.failOn = 'nas_cpu_load';
  const result = await syncCapabilities(planNasCapabilities(FULL), api);

  assert.ok(!result.added.includes('nas_cpu_load'));
  assert.ok(result.added.includes('nas_memory_used'), 'un refus a emporté le reste du plan');
  assert.equal(state.errors.length, 1);
});

test('un hôte dépouillé n\'ajoute que ce qu\'il sait rendre', async () => {
  const { state, api } = sink(['nas_uptime']);
  await syncCapabilities(planNasCapabilities({
    ...FULL, cpuLoad: null, cpuCount: 0, memoryUsedPercent: null, temperature: null, volumes: [],
  }), api);

  assert.deepEqual(state.capabilities, ['nas_uptime'], 'une capability sans valeur a été déclarée');
});
