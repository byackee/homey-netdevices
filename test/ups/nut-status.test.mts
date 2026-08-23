import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NUT_FLAGS,
  hasFlag,
  parseNutStatus,
  toUpsAlarms,
  toUpsStatus,
} from '../../lib/ups/nut-status.mjs';

test('les trois combinaisons observées en production sur Synology', () => {
  assert.deepEqual(parseNutStatus('OL').flags, ['OL']);
  assert.deepEqual(parseNutStatus('OL CHRG').flags, ['OL', 'CHRG']);
  assert.deepEqual(parseNutStatus('OL DISCHRG').flags, ['OL', 'DISCHRG']);
});

test('les jetons se combinent : "OB LB" est sur batterie ET batterie faible', () => {
  const status = parseNutStatus('OB LB');
  assert.deepEqual(status.flags, ['OB', 'LB']);
  assert.ok(hasFlag(status, 'OB'));
  assert.ok(hasFlag(status, 'LB'));
  assert.equal(toUpsStatus(status), 'battery');
  assert.deepEqual(toUpsAlarms(status), {
    onBattery: true, batteryLow: true, overload: false, replaceBattery: false,
  });
});

test('un jeton inconnu est conservé sans faire échouer la lecture', () => {
  const status = parseNutStatus('OL NOUVEAUFLAG CHRG');
  assert.deepEqual(status.flags, ['OL', 'CHRG'], 'les jetons connus restent lus');
  assert.deepEqual(status.unknown, ['NOUVEAUFLAG']);
  assert.equal(toUpsStatus(status), 'normal');
});

test('une chaîne absente ou vide reste « unknown », jamais « normal »', () => {
  for (const raw of [null, undefined, '', '   ']) {
    const status = parseNutStatus(raw);
    assert.deepEqual(status.flags, [], `pour ${JSON.stringify(raw)}`);
    assert.equal(toUpsStatus(status), 'unknown', `pour ${JSON.stringify(raw)}`);
  }
});

test('une chaîne faite uniquement de jetons inconnus reste « unknown »', () => {
  const status = parseNutStatus('WAT ZUT');
  assert.deepEqual(status.unknown, ['WAT', 'ZUT']);
  assert.equal(toUpsStatus(status), 'unknown');
  assert.equal(toUpsAlarms(status).onBattery, false);
});

test('espaces multiples, tabulations et casse minuscule sont tolérés', () => {
  assert.deepEqual(parseNutStatus('OL\t CHRG  ').flags, ['OL', 'CHRG']);
  assert.deepEqual(parseNutStatus('ol chrg').flags, ['OL', 'CHRG']);
});

test('un jeton répété n\'est compté qu\'une fois', () => {
  assert.deepEqual(parseNutStatus('OL OL CHRG').flags, ['OL', 'CHRG']);
});

test('le repli va du plus dégradé au moins dégradé', () => {
  // Un onduleur peut être sur secteur ET en correction de tension : la capability ne
  // porte qu'une valeur, elle doit porter celle qui décrit le risque.
  assert.equal(toUpsStatus(parseNutStatus('OL BOOST')), 'booster');
  assert.equal(toUpsStatus(parseNutStatus('OL TRIM')), 'reducer');
  assert.equal(toUpsStatus(parseNutStatus('OL BYPASS')), 'bypass');
  assert.equal(toUpsStatus(parseNutStatus('OB LB CHRG')), 'battery');
  assert.equal(toUpsStatus(parseNutStatus('OFF OL')), 'off');
  // DISCHRG sans OB suffit : c'est bien la batterie qui alimente.
  assert.equal(toUpsStatus(parseNutStatus('DISCHRG')), 'battery');
});

test('les quatre alarmes se dérivent des seuls jetons', () => {
  assert.equal(toUpsAlarms(parseNutStatus('OL OVER')).overload, true);
  assert.equal(toUpsAlarms(parseNutStatus('OL RB')).replaceBattery, true);
  assert.deepEqual(toUpsAlarms(parseNutStatus('OL CHRG')), {
    onBattery: false, batteryLow: false, overload: false, replaceBattery: false,
  });
});

test('les quatorze jetons documentés sont tous reconnus', () => {
  const expected = ['OL', 'OB', 'LB', 'HB', 'RB', 'CHRG', 'DISCHRG',
    'BYPASS', 'CAL', 'OFF', 'OVER', 'TRIM', 'BOOST', 'FSD'];
  assert.deepEqual(Object.keys(NUT_FLAGS).sort(), [...expected].sort());
  assert.deepEqual(parseNutStatus(expected.join(' ')).unknown, []);
});

// ---------------------------------------------------------------------------
// Les deux axes de NUT : d'où vient le courant, et ce que fait la batterie.
//
// `OL`/`OB` répondent au premier, `CHRG`/`DISCHRG` au second, et ils se combinent.
// Les confondre faisait passer `OL DISCHRG` — l'une des trois combinaisons réellement
// observées en production sur Synology — pour une coupure de courant, ce qui aurait
// coupé les appareils de l'utilisateur alors que le secteur n'avait jamais bronché.
// ---------------------------------------------------------------------------

test('🔴 « OL DISCHRG » n\'est pas une coupure : le secteur est présent', () => {
  const status = parseNutStatus('OL DISCHRG');
  assert.equal(toUpsStatus(status), 'normal');
  assert.equal(toUpsAlarms(status).onBattery, false,
    'un onduleur qui se décharge secteur présent ne doit pas éteindre les appareils');
});

test('🔴 une calibration programmée ne déclenche pas de coupure', () => {
  // `CAL` accompagne une décharge volontaire, secteur présent. C'est le pendant NUT
  // de `APC_TEST_STATUSES`, où la même leçon avait déjà été tirée côté PowerNet.
  const status = parseNutStatus('OL DISCHRG CAL');
  assert.equal(toUpsAlarms(status).onBattery, false);
});

test('« DISCHRG » seul reste une décharge : sans OL, rien ne dit que le secteur est là', () => {
  const status = parseNutStatus('DISCHRG');
  assert.equal(toUpsStatus(status), 'battery');
  assert.equal(toUpsAlarms(status).onBattery, true);
});

test('« OB » reste autoritatif même accompagné d\'un OL contradictoire', () => {
  // Un agent qui publie les deux est incohérent ; on retient le pire des deux.
  const status = parseNutStatus('OL OB');
  assert.equal(toUpsStatus(status), 'battery');
  assert.equal(toUpsAlarms(status).onBattery, true);
});

test('la coupure réelle continue de lever l\'alarme, à tous les stades', () => {
  for (const raw of ['OB', 'OB DISCHRG', 'OB DISCHRG LB']) {
    assert.equal(toUpsAlarms(parseNutStatus(raw)).onBattery, true, raw);
  }
});
