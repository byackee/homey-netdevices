import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { LINK_VALUES, POE_VALUES, planPortCapabilities, portCapabilityValues } from '../../lib/netswitch/capability-map.mjs';
import type { PortSnapshot } from '../../lib/netswitch/port.mjs';

/**
 * Un port qui répond tout ce qu'un switch administrable moderne sait rendre.
 *
 * 🔴 Les valeurs sont **discernables** : aucune ne vaut zéro, aucune n'est égale à une
 * autre, et le débit négocié (2500) diffère des débits mesurés (10 et 20). Une fixture où
 * tout converge laisserait passer une mesure branchée sur le mauvais champ.
 */
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
  octetsWidth: 64,
  octetsIn: 12_500_000,
  octetsOut: 25_000_000,
  discontinuityTicks: 0,
  poe: { ref: { group: 1, port: 5 }, status: 'delivering', adminEnabled: true, groupPowerWatts: 41.5 },
  rxMbps: 10,
  txMbps: 20,
};

/** Un port d'un switch sans PoE interrogé en v1 : pas de Counter64, pas de PoE. */
const PLAIN: PortSnapshot = {
  ...FULL,
  octetsIn: null,
  octetsOut: null,
  discontinuityTicks: null,
  poe: null,
  rxMbps: null,
  txMbps: null,
};

test('🔴 les mesures relevées finissent réellement en capabilities', () => {
  // Le défaut d'origine, côté onduleur : le driver ne déclarait qu'une capability, et
  // douze valeurs sur treize étaient calculées à chaque relevé puis jetées.
  const plan = planPortCapabilities(FULL, { allowControl: false });
  assert.ok(plan.capabilities.length > 5, `seulement ${plan.capabilities.length} capabilities`);
  for (const id of ['netswitch_link', 'netswitch_speed', 'netswitch_rx', 'netswitch_tx',
    'netswitch_errors_in', 'netswitch_errors_out', 'netswitch_poe', 'netswitch_poe_power']) {
    assert.ok(plan.capabilities.includes(id), `${id} manque au plan`);
  }
});

test('🔴 les débits se déclarent sur le COMPTEUR, pas sur le débit', () => {
  // Au premier relevé, `ifHCInOctets` répond mais aucun débit n'est encore calculable —
  // il faut deux échantillons pour une différence. Décider sur le débit reviendrait à ne
  // jamais déclarer la capability, et le port publierait un compteur que personne ne lit.
  const first: PortSnapshot = { ...FULL, rxMbps: null, txMbps: null };
  const plan = planPortCapabilities(first, { allowControl: false });
  assert.ok(plan.capabilities.includes('netswitch_rx'), 'déclarée dès le premier relevé');
  assert.ok(plan.capabilities.includes('netswitch_tx'));
  const rx = plan.values.find((v) => v.id === 'netswitch_rx');
  assert.equal(rx?.value, null, 'déclarée, mais sans valeur inventée');
});

test('🔴 en v1, le Counter64 n\'existe pas : la capability n\'est pas déclarée du tout', () => {
  // Plutôt qu'un débit figé à zéro pour la vie de l'appareil.
  const plan = planPortCapabilities(PLAIN, { allowControl: false });
  assert.equal(plan.capabilities.includes('netswitch_rx'), false);
  assert.equal(plan.capabilities.includes('netswitch_tx'), false);
  assert.ok(plan.omitted.some((o) => o.id === 'netswitch_rx' && o.reason === 'no-value'));
});

test('🔴 onoff n\'existe pas tant que allow_control est faux', () => {
  const off = planPortCapabilities(FULL, { allowControl: false });
  assert.equal(off.capabilities.includes('onoff'), false);
  assert.ok(off.omitted.some((o) => o.id === 'onoff' && o.reason === 'control-disabled'));

  const on = planPortCapabilities(FULL, { allowControl: true });
  assert.ok(on.capabilities.includes('onoff'));
  assert.equal(on.values.find((v) => v.id === 'onoff')?.value, true, 'la valeur vient d\'ifAdminStatus');
});

test('l\'état du lien est toujours déclaré : « unknown » est une valeur, pas une absence', () => {
  const silent: PortSnapshot = { ...PLAIN, link: 'unknown', speedMbps: null, errorsIn: null, errorsOut: null };
  const plan = planPortCapabilities(silent, { allowControl: false });
  assert.deepEqual(plan.capabilities, ['netswitch_link']);
  assert.equal(plan.values[0]?.value, 'unknown');
});

test('sans correspondance PoE, aucune capability PoE n\'est déclarée', () => {
  const plan = planPortCapabilities(PLAIN, { allowControl: false });
  assert.equal(plan.capabilities.includes('netswitch_poe'), false);
  assert.equal(plan.capabilities.includes('netswitch_poe_power'), false);
});

test('un port de switch n\'a pas de batterie : energy reste null', () => {
  assert.equal(planPortCapabilities(FULL, { allowControl: true }).energy, null);
});

test('les valeurs du plan sont branchées sur les bons champs', () => {
  const byId = new Map(planPortCapabilities(FULL, { allowControl: true }).values.map((v) => [v.id, v.value]));
  assert.equal(byId.get('netswitch_speed'), 2_500, 'le débit négocié, pas le débit mesuré');
  assert.equal(byId.get('netswitch_rx'), 10);
  assert.equal(byId.get('netswitch_tx'), 20);
  assert.equal(byId.get('netswitch_errors_in'), 17);
  assert.equal(byId.get('netswitch_errors_out'), 3, 'et pas la même que les erreurs entrantes');
  assert.equal(byId.get('netswitch_poe_power'), 41.5);
  assert.equal(byId.get('netswitch_poe'), 'delivering');
  assert.equal(byId.get('netswitch_link'), 'up');
});

test('🔴 une mesure qui disparaît reçoit null, jamais zéro', () => {
  // Zéro se lirait comme « aucune erreur » ou « aucun trafic » : deux affirmations.
  const lost: PortSnapshot = { ...FULL, errorsIn: null, rxMbps: null, poe: null };
  const declared = planPortCapabilities(FULL, { allowControl: false }).capabilities;
  const byId = new Map(portCapabilityValues(lost, declared).map((v) => [v.id, v.value]));
  assert.equal(byId.get('netswitch_errors_in'), null);
  assert.equal(byId.get('netswitch_rx'), null);
  assert.equal(byId.get('netswitch_poe'), null, 'une correspondance perdue n\'est pas « désactivé »');
  assert.notEqual(byId.get('netswitch_poe'), 'disabled');
});

test('une capability inconnue de la table est ignorée sans erreur', () => {
  // Elle a pu être posée par une version antérieure : on ne retire jamais rien.
  const values = portCapabilityValues(FULL, ['netswitch_link', 'measure_battery', 'ups_status']);
  assert.deepEqual(values.map((v) => v.id), ['netswitch_link']);
});

test('les vocabulaires déclarés à Homey couvrent tout le type', () => {
  // Le `Record<…, true>` de `capability-map.mts` est un garde-fou de compilation ; celui-ci
  // vérifie que les fichiers `.homeycompose/capabilities/` n'ont pas divergé du code.
  assert.equal(LINK_VALUES.length, 7);
  assert.ok(LINK_VALUES.includes('lowerLayerDown'));
  assert.equal(POE_VALUES.length, 7);
  assert.ok(POE_VALUES.includes('otherFault'));
});
