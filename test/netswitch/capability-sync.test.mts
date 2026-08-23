import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { syncCapabilities, type CapabilitySink } from '../../lib/ups/capability-sync.mjs';
import { planPortCapabilities } from '../../lib/netswitch/capability-map.mjs';
import type { PortSnapshot } from '../../lib/netswitch/port.mjs';

/**
 * Un double de `Homey.Device` réduit aux seuls effets qui nous intéressent.
 *
 * `syncCapabilities` est le module de l'onduleur, réutilisé tel quel : il prend un PLAN,
 * pas un snapshot d'onduleur. Cette suite est donc autant un test du port qu'une preuve
 * que le socle est réellement générique — si quelqu'un y réintroduit une notion d'onduleur,
 * c'est ici que ça casse.
 */
function sink(existing: string[] = []) {
  const state = {
    capabilities: [...existing],
    options: new Map<string, unknown>(),
    energy: null as unknown,
    logs: [] as string[],
    errors: [] as string[],
  };
  const api: CapabilitySink = {
    listCapabilities: () => state.capabilities,
    addCapability: async (id) => { state.capabilities.push(id); },
    setCapabilityOptions: async (id, options) => { state.options.set(id, options); },
    setEnergy: async (energy) => { state.energy = energy; },
    log: (m) => state.logs.push(m),
    error: (m) => state.errors.push(m),
  };
  return { state, api };
}

const FULL: PortSnapshot = {
  ifIndex: 5,
  name: 'Gi1/0/5',
  description: 'GigabitEthernet1/0/5',
  alias: 'Caméra jardin',
  type: 6,
  speedMbps: 2_500,
  link: 'up',
  adminUp: true,
  errorsIn: 17,
  errorsOut: 3,
  octetsIn: 12_500_000,
  octetsOut: 25_000_000,
  discontinuityTicks: 0,
  poe: { ref: { group: 1, port: 5 }, status: 'delivering', adminEnabled: true, groupPowerWatts: 41.5 },
  rxMbps: 10,
  txMbps: 20,
};

test('🔴 le plan d\'un port dépasse largement la seule capability du driver.compose', () => {
  // `drivers/netswitch/driver.compose.json` n'en déclare qu'une. Si l'alignement n'est
  // pas branché, un port n'affiche que l'état du lien et tout le reste est jeté.
  const { state, api } = sink(['netswitch_link']);
  return syncCapabilities(planPortCapabilities(FULL, { allowControl: false }), api).then((result) => {
    assert.ok(result.added.length > 0, 'rien n\'a été ajouté : les mesures seraient jetées');
    assert.ok(state.capabilities.includes('netswitch_speed'));
    assert.ok(state.capabilities.includes('netswitch_rx'));
    assert.ok(state.capabilities.includes('netswitch_poe_power'));
    assert.ok(state.capabilities.length > 5, `seulement ${state.capabilities.length} capabilities`);
  });
});

test('l\'alignement est idempotent : rejoué, il n\'écrit rien', () => {
  // Il tourne dans une boucle à dix secondes, sur chacun des N ports d'un même switch.
  const plan = planPortCapabilities(FULL, { allowControl: false });
  const { state, api } = sink(['netswitch_link']);
  return syncCapabilities(plan, api)
    .then(() => syncCapabilities(plan, api))
    .then((second) => {
      assert.deepEqual(second.added, []);
      assert.equal(second.changed, false);
      assert.equal(state.capabilities.length, plan.capabilities.length);
    });
});

test('🔴 aucune capability n\'est jamais retirée, même quand le port cesse de la rendre', async () => {
  // `removeCapability` détruit l'historique Insights de façon irréversible.
  const lost: PortSnapshot = { ...FULL, poe: null, octetsIn: null, octetsOut: null };
  const { state, api } = sink(['netswitch_link', 'netswitch_poe', 'netswitch_rx']);
  const result = await syncCapabilities(planPortCapabilities(lost, { allowControl: false }), api);
  assert.ok(state.capabilities.includes('netswitch_poe'), 'conservée pour l\'historique');
  assert.ok(result.orphaned.includes('netswitch_poe'), 'signalée, jamais retirée');
});

test('🔴 energy.batteries n\'est jamais posé sur un port de switch', async () => {
  // Poser cette clé mentirait à Homey sur la nature de l'appareil, et elle n'a pas de
  // retour en arrière propre.
  const { state, api } = sink(['netswitch_link']);
  await syncCapabilities(planPortCapabilities(FULL, { allowControl: true }), api);
  assert.equal(state.energy, null);
});

test('cocher allow_control ajoute onoff sur un appareil déjà appairé', async () => {
  const { state, api } = sink(['netswitch_link', 'netswitch_speed']);
  await syncCapabilities(planPortCapabilities(FULL, { allowControl: false }), api);
  assert.equal(state.capabilities.includes('onoff'), false);

  const result = await syncCapabilities(planPortCapabilities(FULL, { allowControl: true }), api);
  assert.ok(result.added.includes('onoff'), 'la case cochée doit ajouter la commande');
});
