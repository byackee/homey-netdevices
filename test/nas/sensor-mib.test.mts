import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  SCALE_EXPONENT,
  SENSOR_STATUS,
  SENSOR_TYPE,
  decodeSensor,
  hottestSensor,
  type SensorRow,
} from '../../lib/nas/sensor-mib.mjs';

/** Un capteur qui va bien, dont chaque test ne change que ce qui l'intéresse. */
function sensor(overrides: Partial<SensorRow> = {}): SensorRow {
  return {
    index: 1,
    type: SENSOR_TYPE.celsius,
    scale: 9, // units
    precision: 0,
    value: 42,
    operStatus: SENSOR_STATUS.ok,
    ...overrides,
  };
}

test('🔴 les fixtures de capteur distinguent bien les décodages candidats', () => {
  // Une valeur de 3125 avec deux décimales : 31,25 °C. Prise telle quelle, 3125 °C.
  // Divisée par dix au lieu de cent, 312,5 °C. Les trois sont distinctes, donc une
  // erreur de précision se voit.
  assert.equal(new Set([3125, 3125 / 10, 3125 / 100]).size, 3);
});

test('decodeSensor applique la précision : 3125 avec deux décimales font 31,25 °C', () => {
  assert.equal(decodeSensor(sensor({ value: 3125, precision: 2 })), 31.3,
    'arrondi au dixième, comme toutes les mesures de cette app');
  assert.equal(decodeSensor(sensor({ value: 425, precision: 1 })), 42.5);
  assert.equal(decodeSensor(sensor({ value: 42, precision: 0 })), 42);
});

test('decodeSensor applique l\'échelle : un capteur en milli-degrés reste lisible', () => {
  // 42 000 milli-degrés font 42 °C. Sans l'échelle, 42 000 °C — écarté par les bornes,
  // donc le capteur disparaîtrait au lieu d'être lu.
  assert.equal(decodeSensor(sensor({ value: 42_000, scale: 8, precision: 0 })), 42);
});

test('🔴 l\'échelle de la RFC n\'est pas l\'échelle SI : exa vient avant peta', () => {
  // `EntitySensorDataScale` liste `exa(14)` AVANT `peta(15)`, à l'envers des préfixes SI.
  // Un exposant calculé par (scale − 9) × 3 serait juste partout sauf sur ces deux
  // valeurs — donc faux d'un facteur mille, et jamais attrapé par un capteur réel.
  assert.equal(SCALE_EXPONENT[14], 18, 'exa(14) vaut 10¹⁸');
  assert.equal(SCALE_EXPONENT[15], 15, 'peta(15) vaut 10¹⁵');
  assert.ok(SCALE_EXPONENT[14]! > SCALE_EXPONENT[15]!, 'l\'inversion de la RFC a été perdue');
  assert.equal(SCALE_EXPONENT[9], 0, 'units est l\'exposant neutre');
  assert.equal(SCALE_EXPONENT[8], -3, 'milli');
});

test('🔴 un capteur qui n\'est pas en degrés n\'est jamais lu comme une température', () => {
  // La même table porte des volts, des watts, de l'humidité et des tours par minute.
  // 3 200 tr/min afficherait « 3 200 °C » — écarté par les bornes ici, mais 45 % d'humidité
  // afficherait « 45 °C », ce qui est parfaitement crédible et parfaitement faux.
  assert.equal(decodeSensor(sensor({ type: SENSOR_TYPE.percentRH, value: 45 })), null);
  assert.equal(decodeSensor(sensor({ type: SENSOR_TYPE.rpm, value: 42 })), null);
  assert.equal(decodeSensor(sensor({ type: SENSOR_TYPE.voltsDC, value: 12 })), null);
  assert.equal(decodeSensor(sensor({ type: SENSOR_TYPE.other })), null);
  assert.equal(decodeSensor(sensor({ type: null })), null, 'un type absent ne se devine pas');
});

test('🔴 un capteur hors service rend null, jamais sa dernière valeur ni zéro', () => {
  // Un capteur débranché rend souvent `0`, ce qui se lirait comme un NAS très froid.
  assert.equal(decodeSensor(sensor({ operStatus: SENSOR_STATUS.unavailable, value: 0 })), null);
  assert.equal(decodeSensor(sensor({ operStatus: SENSOR_STATUS.nonoperational })), null);
});

test('un operStatus absent est traité comme ok : la colonne est optionnelle', () => {
  assert.equal(decodeSensor(sensor({ operStatus: null })), 42);
});

test('une échelle ou une précision absente retombe sur sa valeur neutre', () => {
  assert.equal(decodeSensor(sensor({ scale: null })), 42, 'pas d\'échelle = units');
  assert.equal(decodeSensor(sensor({ precision: null })), 42, 'pas de précision = zéro décimale');
});

test('decodeSensor refuse ce qui n\'est physiquement pas une température d\'appareil', () => {
  assert.equal(decodeSensor(sensor({ value: 4000 })), null, '4 000 °C');
  assert.equal(decodeSensor(sensor({ value: -273 })), null, 'le zéro absolu n\'est pas une salle serveur');
  assert.equal(decodeSensor(sensor({ value: null })), null);
  assert.equal(decodeSensor(sensor({ value: Number.NaN })), null);
  assert.equal(decodeSensor(sensor({ scale: 99 })), null, 'échelle hors énumération');
  assert.equal(decodeSensor(sensor({ precision: 42 })), null, 'précision hors 0..9');
});

test('decodeSensor accepte les bornes elles-mêmes', () => {
  assert.equal(decodeSensor(sensor({ value: 0 })), 0, 'zéro degré est une mesure');
  assert.equal(decodeSensor(sensor({ value: -40 })), -40);
  assert.equal(decodeSensor(sensor({ value: 150 })), 150);
});

// ---------------------------------------------------------------------------

test('🔴 hottestSensor retient le maximum, pas la moyenne', () => {
  // Un seul disque à 58 °C est un disque qui va mourir. La moyenne de six capteurs le
  // noierait à 38 °C, c'est-à-dire diluerait précisément l'information qu'on cherche.
  const rows = [
    sensor({ index: 1, value: 34 }),
    sensor({ index: 2, value: 58 }),
    sensor({ index: 3, value: 31 }),
    sensor({ index: 4, value: 33 }),
  ];
  assert.equal(hottestSensor(rows), 58);
  assert.notEqual(hottestSensor(rows), 39, 'c\'est la moyenne, pas le maximum');
});

test('hottestSensor ignore les capteurs illisibles sans perdre les autres', () => {
  const rows = [
    sensor({ index: 1, type: SENSOR_TYPE.rpm, value: 3200 }),
    sensor({ index: 2, operStatus: SENSOR_STATUS.unavailable, value: 99 }),
    sensor({ index: 3, value: 41 }),
  ];
  assert.equal(hottestSensor(rows), 41);
});

test('hottestSensor rend null quand aucun capteur n\'est exploitable', () => {
  // Donc la capability n'est pas déclarée, ce qui est exactement ce qu'on veut dire :
  // HOST-RESOURCES-MIB ne publie aucune température, et la plupart des Linux
  // n'implémentent pas ENTITY-SENSOR-MIB.
  assert.equal(hottestSensor([]), null);
  assert.equal(hottestSensor([sensor({ type: SENSOR_TYPE.watts })]), null);
});
