import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { syncCapabilities, type CapabilitySink } from '../../lib/ups/capability-sync.mjs';
import { planCapabilities } from '../../lib/ups/capability-map.mjs';
import type { UpsSnapshot } from '../../lib/ups/snapshot.mjs';

/**
 * Un double de `Homey.Device` réduit aux seuls effets qui nous intéressent.
 *
 * C'est ce que l'extraction achète : la vraie logique est exercée, pas une
 * réimplémentation. Avant elle, la totalité de ce chemin vivait dans `device.mts`,
 * qu'aucun test ne peut importer — le paquet `homey` étant la CLI.
 */
function sink(existing: string[] = []) {
  const state = {
    capabilities: [...existing],
    options: new Map<string, unknown>(),
    energy: null as unknown,
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
    setEnergy: async (energy) => { state.energy = energy; },
    log: (m) => state.logs.push(m),
    error: (m) => state.errors.push(m),
  };
  return { state, api };
}

/** Un onduleur qui publie tout ce que Synology sait rendre. */
const FULL: UpsSnapshot = {
  source: 'synology',
  model: 'Back-UPS ES 700G', manufacturer: 'APC', serial: 'SIM1',
  status: 'normal',
  alarms: { onBattery: false, batteryLow: false, overload: false, replaceBattery: false },
    alarmSummary: null,
  batteryCharge: 100, runtimeMinutes: 60, load: 18,
  inputVoltage: null, outputVoltage: null, outputPower: null,
  batteryVoltage: 13.4, batteryTemperature: 24,
  batteryChargeLow: 30, runtimeLowMinutes: 5,
};

test('🔴 les mesures relevées finissent réellement en capabilities', () => {
  // Le défaut d'origine : le driver ne déclarait que `ups_status`, `writeValues()`
  // n'itérait que sur les capabilities existantes, et douze valeurs sur treize étaient
  // calculées à chaque relevé puis jetées avant d'atteindre Homey.
  const { state, api } = sink(['ups_status']);
  return syncCapabilities(planCapabilities(FULL), api).then((result) => {
    assert.ok(result.added.length > 0, 'rien n\'a été ajouté : les mesures seraient jetées');
    assert.ok(state.capabilities.includes('measure_battery'), 'la charge doit être publiée');
    assert.ok(state.capabilities.includes('ups_runtime'), 'l\'autonomie doit être publiée');
    assert.ok(state.capabilities.includes('alarm_ups_onbattery'), 'l\'alarme de coupure doit être publiée');
    assert.ok(state.capabilities.length > 5, `seulement ${state.capabilities.length} capabilities`);
  });
});

test('energy.batteries est posé dès qu\'une capability de batterie existe', async () => {
  const { state, api } = sink(['ups_status']);
  await syncCapabilities(planCapabilities(FULL), api);
  assert.deepEqual(state.energy, { batteries: ['INTERNAL'] },
    'Homey exige energy.batteries avec measure_battery, et la batterie est bien dans l\'onduleur');
});

test('les sous-capabilités reçoivent un titre : Homey n\'en génère aucun', async () => {
  const { state, api } = sink(['ups_status']);
  await syncCapabilities(planCapabilities(FULL), api);
  const titled = [...state.options.keys()];
  assert.ok(titled.length > 0, 'sans titres, trois tensions s\'afficheraient toutes « Voltage »');
});

test('🔴 aucune capability n\'est jamais retirée, même sans source', async () => {
  // `removeCapability` détruit l'historique Insights de façon irréversible.
  const { state, api } = sink(['ups_status', 'measure_power', 'une_capability_inconnue']);
  const before = [...state.capabilities];
  const result = await syncCapabilities(planCapabilities(FULL), api);
  for (const id of before) {
    assert.ok(state.capabilities.includes(id), `${id} a disparu : l'historique serait perdu`);
  }
  assert.ok(result.orphaned.includes('une_capability_inconnue'),
    'une orpheline doit être signalée, pas supprimée');
});

test('idempotent : un second passage n\'écrit rien', async () => {
  // Appelé à chaque relevé, donc toutes les dix secondes. Une écriture persistante par
  // tick serait un défaut en soi (plan §8.6).
  const { state, api } = sink(['ups_status']);
  await syncCapabilities(planCapabilities(FULL), api);
  const logsAfterFirst = state.logs.length;
  const second = await syncCapabilities(planCapabilities(FULL), api);
  assert.equal(second.changed, false, 'le second passage a écrit alors que le plan était satisfait');
  assert.equal(second.added.length, 0);
  assert.equal(state.logs.length, logsAfterFirst, 'et il n\'a rien journalisé non plus');
});

test('un refus de Homey sur une capability n\'emporte pas les autres', async () => {
  const { state, api } = sink(['ups_status']);
  state.failOn = 'measure_battery';
  const result = await syncCapabilities(planCapabilities(FULL), api);
  assert.ok(!result.added.includes('measure_battery'));
  assert.ok(result.added.length > 0, 'les autres capabilities doivent quand même passer');
  assert.equal(state.errors.length, 1);
});

test('une source avare ne déclare que ce qu\'elle rend', async () => {
  const bare: UpsSnapshot = {
    ...FULL,
    batteryCharge: null, runtimeMinutes: null, load: null,
    batteryVoltage: null, batteryTemperature: null,
    batteryChargeLow: null, runtimeLowMinutes: null,
  };
  const { state, api } = sink(['ups_status']);
  await syncCapabilities(planCapabilities(bare), api);
  assert.ok(!state.capabilities.includes('measure_battery'),
    'une mesure absente ne doit pas être déclarée puis posée à null');
});
