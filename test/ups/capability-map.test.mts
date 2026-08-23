import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  UPS_STATUS_VALUES,
  capabilityValues,
  planCapabilities,
  reconcileCapabilities,
} from '../../lib/ups/capability-map.mjs';
import type { UpsSnapshot, UpsSource } from '../../lib/ups/snapshot.mjs';

const SOURCES: readonly UpsSource[] = ['synology', 'rfc1628', 'apc', 'qnap'];

/**
 * Un onduleur qui répond à tout, avec des valeurs **deux à deux distinctes**.
 *
 * C'est l'équivalent, pour le mapping, du garde-fou d'autonomie de `reader.test.mts`
 * (plan §8.5) : si `inputVoltage` et `outputVoltage` valaient tous deux 230, intervertir
 * les deux sous-capabilities laisserait la suite au vert. Un test plus bas épingle cette
 * propriété du jeu d'essai lui-même, pour qu'on ne puisse pas la perdre sans le voir.
 */
function fullSnapshot(source: UpsSource = 'rfc1628'): UpsSnapshot {
  return {
    source,
    model: 'Eaton 3S 700',
    manufacturer: 'EATON',
    serial: 'G1234X56789',
    status: 'normal',
    alarms: { onBattery: false, batteryLow: false, overload: false, replaceBattery: false },
    alarmSummary: null,
    batteryCharge: 87,
    runtimeMinutes: 33,
    load: 42,
    inputVoltage: 231,
    outputVoltage: 228,
    outputPower: 310,
    batteryVoltage: 27.2,
    batteryTemperature: 24.5,
    batteryChargeLow: 20,
    runtimeLowMinutes: 3,
  };
}

/** La racine du dépôt, retrouvée depuis le fichier compilé sous `.testbuild/`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, '.homeycompose'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('racine du dépôt introuvable depuis ' + import.meta.url);
}

/** Toutes les capabilities que le mapping peut produire, déclarées ou écartées. */
function everyCandidate(): string[] {
  const ids = new Set<string>();
  for (const source of SOURCES) {
    const plan = planCapabilities(fullSnapshot(source));
    for (const id of plan.capabilities) ids.add(id);
    for (const { id } of plan.omitted) ids.add(id);
  }
  return [...ids];
}

/** Les préfixes que Homey fournit lui-même ; tout le reste doit exister dans `.homeycompose`. */
const SYSTEM_CAPABILITIES = new Set([
  'measure_battery', 'measure_voltage', 'measure_power', 'measure_temperature', 'alarm_battery',
]);

// ---------------------------------------------------------------------------
// Le jeu d'essai doit prouver quelque chose
// ---------------------------------------------------------------------------

test('la fixture rend toute erreur de câblage visible : ses mesures sont deux à deux distinctes', () => {
  const s = fullSnapshot();
  const measured = [
    s.batteryCharge, s.runtimeMinutes, s.load,
    s.inputVoltage, s.outputVoltage, s.outputPower,
    s.batteryVoltage, s.batteryTemperature,
  ];
  assert.equal(
    new Set(measured).size,
    measured.length,
    'deux mesures égales rendraient une inversion de câblage indétectable',
  );
});

// ---------------------------------------------------------------------------
// Le plan de déclaration
// ---------------------------------------------------------------------------

test('un onduleur complet déclare chaque mesure sur la bonne capability', () => {
  const s = fullSnapshot();
  const { capabilities, values } = planCapabilities(s);
  const byId = new Map(values.map((v) => [v.id, v.value]));

  assert.equal(capabilities[0], 'ups_status', 'l\'état vient en tête');
  assert.equal(byId.get('ups_status'), 'normal');
  assert.equal(byId.get('measure_battery'), 87);
  assert.equal(byId.get('ups_runtime'), 33);
  assert.equal(byId.get('ups_load'), 42);
  assert.equal(byId.get('measure_voltage.input'), 231);
  assert.equal(byId.get('measure_voltage.output'), 228);
  assert.equal(byId.get('measure_power'), 310);
  assert.equal(byId.get('measure_temperature'), 24.5);

  // ⚠️ La tension batterie (DC) a sa propre sous-capability : l'afficher sous
  // `measure_voltage.output` (AC) est le piège que le plan §3.2 signale chez Synology.
  assert.equal(byId.get('measure_voltage.battery'), 27.2);
  assert.notEqual(byId.get('measure_voltage.output'), s.batteryVoltage);

  assert.equal(values.length, capabilities.length, 'une valeur par capability, dans le même ordre');
  assert.deepEqual(values.map((v) => v.id), capabilities);
});

test('les seuils ne sont pas des mesures et ne deviennent pas des capabilities', () => {
  // `batteryChargeLow` et `runtimeLowMinutes` sont des réglages de l'onduleur : constants,
  // ils ne feraient qu'ajouter deux lignes plates dans Insights.
  const { capabilities, values } = planCapabilities(fullSnapshot());
  assert.ok(!capabilities.some((id) => id.includes('low')));
  assert.ok(!values.some((v) => v.value === 20 || v.value === 3));
});

test('🔴 une mesure absente n\'est pas déclarée du tout — jamais posée à null pour être retirée', () => {
  const s = { ...fullSnapshot('synology'), inputVoltage: null, outputVoltage: null, outputPower: null };
  const plan = planCapabilities(s);

  for (const id of ['measure_voltage.input', 'measure_voltage.output', 'measure_power']) {
    assert.ok(!plan.capabilities.includes(id), `${id} ne doit pas être déclarée`);
    assert.deepEqual(
      plan.omitted.find((o) => o.id === id),
      { id, reason: 'no-value' },
    );
  }
  assert.ok(!plan.values.some((v) => v.value === null), 'aucune valeur nulle dans un plan de déclaration');

  // Ce que Synology sait donner reste là.
  assert.ok(plan.capabilities.includes('measure_voltage.battery'));
  assert.ok(plan.capabilities.includes('measure_battery'));
});

test('🔴 une batterie réellement vide vaut 0 et ne déclenche aucune alarme à elle seule', () => {
  // Le piège du plan §8.5 : un `null` casté en `0` allumerait `alarm_battery` *et*
  // `alarm_ups_onbattery` — une fausse alerte de coupure de courant, en pleine nuit.
  const s = { ...fullSnapshot(), batteryCharge: 0, load: 0, runtimeMinutes: 0 };
  const byId = new Map(planCapabilities(s).values.map((v) => [v.id, v.value]));

  assert.equal(byId.get('measure_battery'), 0, '0 % est une valeur, pas une absence');
  assert.equal(byId.get('ups_load'), 0);
  assert.equal(byId.get('ups_runtime'), 0);
  assert.equal(byId.get('alarm_battery'), false, 'les alarmes viennent des drapeaux, pas des mesures');
  assert.equal(byId.get('alarm_ups_onbattery'), false);
});

test('une charge inconnue n\'allume pas d\'alarme non plus, et ne déclare pas measure_battery', () => {
  const s = { ...fullSnapshot(), batteryCharge: null };
  const plan = planCapabilities(s);
  const byId = new Map(plan.values.map((v) => [v.id, v.value]));

  assert.ok(!plan.capabilities.includes('measure_battery'));
  assert.equal(byId.get('alarm_battery'), false);
  assert.equal(byId.get('alarm_ups_onbattery'), false);
});

test('les alarmes recopient les drapeaux du snapshot, sans les recalculer', () => {
  const s = fullSnapshot();
  s.alarms = { onBattery: true, batteryLow: true, overload: true, replaceBattery: true };
  s.status = 'battery';
  const byId = new Map(planCapabilities(s).values.map((v) => [v.id, v.value]));

  assert.equal(byId.get('ups_status'), 'battery');
  assert.equal(byId.get('alarm_ups_onbattery'), true);
  assert.equal(byId.get('alarm_battery'), true);
  assert.equal(byId.get('alarm_ups_overload'), true);
  assert.equal(byId.get('alarm_ups_replace_battery'), true);
});

test('l\'état est toujours déclaré, « unknown » compris — « je ne sais pas » est une valeur', () => {
  for (const source of SOURCES) {
    const s = { ...fullSnapshot(source), status: 'unknown' as const };
    const plan = planCapabilities(s);
    assert.ok(plan.capabilities.includes('ups_status'), `pour ${source}`);
    assert.equal(plan.values[0]?.value, 'unknown', `pour ${source}`);
  }
});

test('APC n\'expose pas la surcharge : la capability n\'est pas déclarée plutôt que figée à false', () => {
  const plan = planCapabilities(fullSnapshot('apc'));
  assert.ok(!plan.capabilities.includes('alarm_ups_overload'));
  assert.deepEqual(
    plan.omitted.find((o) => o.id === 'alarm_ups_overload'),
    { id: 'alarm_ups_overload', reason: 'unsupported-by-source' },
  );
  // Les trois autres restent, elles.
  assert.ok(plan.capabilities.includes('alarm_battery'));
  assert.ok(plan.capabilities.includes('alarm_ups_onbattery'));
  assert.ok(plan.capabilities.includes('alarm_ups_replace_battery'));
});

test('un dialecte confirmé déclare la surcharge', () => {
  for (const source of ['synology', 'rfc1628'] as const) {
    assert.ok(
      planCapabilities(fullSnapshot(source)).capabilities.includes('alarm_ups_overload'),
      `pour ${source}`,
    );
  }
});

// ---------------------------------------------------------------------------
// energy.batteries et les titres des sous-capabilities
// ---------------------------------------------------------------------------

test('measure_battery et alarm_battery imposent energy.batteries = ["INTERNAL"]', () => {
  for (const source of SOURCES) {
    const plan = planCapabilities(fullSnapshot(source));
    assert.deepEqual(plan.energy, { batteries: ['INTERNAL'] }, `pour ${source}`);
  }
});

test('les quatre dialectes savent tous lire la batterie : energy n\'est jamais absente', () => {
  // Invariant délibéré : si un jour une source cesse d'exposer et la charge et le drapeau
  // LB, ce test tombe et rappelle que la clé `energy` doit alors ne pas être posée du tout.
  for (const source of SOURCES) {
    const plan = planCapabilities({ ...fullSnapshot(source), batteryCharge: null });
    assert.ok(plan.capabilities.includes('alarm_battery'), `pour ${source}`);
    assert.deepEqual(plan.energy, { batteries: ['INTERNAL'] }, `pour ${source}`);
  }
});

test('seules les sous-capabilities reçoivent un titre : Homey n\'en génère aucun pour elles', () => {
  const plan = planCapabilities(fullSnapshot());
  assert.deepEqual(
    [...plan.options.keys()].sort(),
    ['measure_voltage.battery', 'measure_voltage.input', 'measure_voltage.output'],
  );
  for (const [id, opts] of plan.options) {
    assert.ok(id.includes('.'), `${id} n'est pas une sous-capability et n'a pas besoin de titre`);
    for (const lang of ['en', 'fr', 'nl'] as const) {
      assert.ok(opts.title[lang].length > 0, `${id} sans titre ${lang}`);
    }
  }
  const titles = [...plan.options.values()].map((o) => o.title.en);
  assert.equal(new Set(titles).size, titles.length, 'trois lignes « Voltage » identiques seraient illisibles');
});

test('une sous-capability non déclarée n\'apporte pas son titre', () => {
  const plan = planCapabilities({ ...fullSnapshot(), inputVoltage: null });
  assert.ok(!plan.options.has('measure_voltage.input'));
});

// ---------------------------------------------------------------------------
// Les capabilities déclarées existent vraiment
// ---------------------------------------------------------------------------

test('toute capability produite est standard Homey ou définie dans .homeycompose', () => {
  const root = repoRoot();
  for (const id of everyCandidate()) {
    const base = id.split('.')[0]!;
    if (SYSTEM_CAPABILITIES.has(base)) continue;
    const file = join(root, '.homeycompose', 'capabilities', `${id}.json`);
    assert.ok(existsSync(file), `${id} n'est ni standard ni défini dans ${file}`);
  }
});

test('l\'énumération ups_status déclarée à Homey est exactement le vocabulaire commun', () => {
  const file = join(repoRoot(), '.homeycompose', 'capabilities', 'ups_status.json');
  const declared = JSON.parse(readFileSync(file, 'utf8')) as { values: Array<{ id: string }> };
  assert.deepEqual(declared.values.map((v) => v.id), UPS_STATUS_VALUES);
  assert.equal(UPS_STATUS_VALUES.length, 7, 'les sept valeurs de upsOutputSource');
});

// ---------------------------------------------------------------------------
// Les écritures d'un appareil déjà appairé
// ---------------------------------------------------------------------------

test('🔴 une capability déclarée dont la mesure disparaît reçoit null, pas 0', () => {
  const declared = planCapabilities(fullSnapshot()).capabilities;
  const lost = { ...fullSnapshot(), batteryCharge: null, outputPower: null };
  const byId = new Map(capabilityValues(lost, declared).map((v) => [v.id, v.value]));

  assert.equal(byId.get('measure_battery'), null);
  assert.equal(byId.get('measure_power'), null);
  assert.ok(byId.has('measure_battery'), 'la capability reste écrite, elle n\'est pas silencieusement sautée');
  assert.notEqual(byId.get('measure_battery'), 0, '0 % déclencherait une fausse alerte de coupure');
});

test('capabilityValues rend exactement les capabilities demandées, dans l\'ordre demandé', () => {
  const s = fullSnapshot();
  const declared = planCapabilities(s).capabilities;
  assert.deepEqual(capabilityValues(s, declared).map((v) => v.id), declared);
  assert.deepEqual(capabilityValues(s, declared), planCapabilities(s).values);
});

test('une capability inconnue de la table est ignorée sans faire échouer le cycle', () => {
  // Elle a pu être posée par une version antérieure ; on ne la retire pas, on ne l'écrit pas.
  const values = capabilityValues(fullSnapshot(), ['measure_battery', 'onlooker_capability']);
  assert.deepEqual(values.map((v) => v.id), ['measure_battery']);
});

test('une alarme que la source courante n\'expose pas devient inconnue, jamais false', () => {
  // Le NAS relais a été remplacé par une carte réseau APC : l'appareil porte toujours
  // `alarm_ups_overload`, qu'APC ne sait pas produire.
  const declared = planCapabilities(fullSnapshot('synology')).capabilities;
  const byId = new Map(capabilityValues(fullSnapshot('apc'), declared).map((v) => [v.id, v.value]));
  assert.equal(byId.get('alarm_ups_overload'), null);
  assert.equal(byId.get('alarm_ups_onbattery'), false, 'celles qu\'APC expose gardent leur valeur');
});

// ---------------------------------------------------------------------------
// removeCapability n'a pas de chemin d'accès
// ---------------------------------------------------------------------------

test('🔴 la réconciliation ajoute, signale, et n\'offre aucun moyen de retirer', () => {
  const result = reconcileCapabilities(
    ['ups_status', 'measure_battery', 'supply_black'],
    ['ups_status', 'measure_battery', 'ups_runtime'],
  );
  assert.deepEqual(result.toAdd, ['ups_runtime']);
  assert.deepEqual(result.orphaned, ['supply_black']);
  assert.deepEqual(
    Object.keys(result).sort(),
    ['orphaned', 'toAdd'],
    'aucune clé « toRemove » : removeCapability détruit l\'historique Insights sans retour',
  );
});

test('un appareil neuf ajoute tout le plan, un appareil à jour n\'ajoute rien', () => {
  const planned = planCapabilities(fullSnapshot()).capabilities;
  assert.deepEqual(reconcileCapabilities([], planned).toAdd, planned);
  const settled = reconcileCapabilities(planned, planned);
  assert.deepEqual(settled.toAdd, []);
  assert.deepEqual(settled.orphaned, []);
});

test('une mesure perdue un cycle est signalée orpheline, pas retirée', () => {
  const declared = planCapabilities(fullSnapshot()).capabilities;
  const degraded = planCapabilities({ ...fullSnapshot(), outputPower: null }).capabilities;
  const result = reconcileCapabilities(declared, degraded);
  assert.deepEqual(result.orphaned, ['measure_power']);
  assert.deepEqual(result.toAdd, []);
});
