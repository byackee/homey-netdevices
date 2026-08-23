import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { APC_OUTPUT_STATUS, APC_UPS_OID } from '../../lib/ups/apc-mib.mjs';
import { RFC1628_UPS_OID } from '../../lib/ups/rfc1628-mib.mjs';
import { SYNOLOGY_UPS_OID } from '../../lib/ups/synology-mib.mjs';
import {
  UPS_SOURCE_READERS,
  detectUpsSource,
  readUpsSnapshot,
  readerForSource,
} from '../../lib/ups/sources.mjs';
import { fakeSource, unreachableSource } from './fake-source.mjs';

const SYNOLOGY = { [SYNOLOGY_UPS_OID.infoStatus]: 'OL CHRG' };
const RFC1628 = { [RFC1628_UPS_OID.outputSource]: 3, [RFC1628_UPS_OID.batteryStatus]: 2 };
const APC = {
  [APC_UPS_OID.basicOutputStatus]: APC_OUTPUT_STATUS.onLine,
  [APC_UPS_OID.basicBatteryStatus]: 2,
};

test('l\'ordre d\'essai est Synology, RFC 1628, APC', () => {
  assert.deepEqual(UPS_SOURCE_READERS.map((r) => r.source), ['synology', 'rfc1628', 'apc']);
});

test('QNAP est admis par le type mais absent de la liste : on ne le sait pas lire', () => {
  assert.equal(readerForSource('qnap'), null);
  assert.equal(readerForSource('rfc1628')?.source, 'rfc1628');
  assert.equal(readerForSource('apc')?.source, 'apc');
  assert.equal(readerForSource('synology')?.source, 'synology');
});

test('chaque source est détectée sur son propre dialecte', async () => {
  assert.equal((await detectUpsSource(fakeSource(SYNOLOGY))).reader?.source, 'synology');
  assert.equal((await detectUpsSource(fakeSource(RFC1628))).reader?.source, 'rfc1628');
  assert.equal((await detectUpsSource(fakeSource(APC))).reader?.source, 'apc');
});

test('un appareil qui parle deux dialectes est pris par le premier de la liste', async () => {
  // Un APC équipé d'une carte moderne répond aux deux : le standard gagne, parce que ce
  // qu'il rend a la même signification chez tous les constructeurs.
  const detection = await detectUpsSource(fakeSource({ ...RFC1628, ...APC }));
  assert.equal(detection.reader?.source, 'rfc1628');
  assert.deepEqual(detection.declined, ['synology']);
});

test('🔴 un appareil joignable qui n\'est pas un onduleur rend null, sans erreur', async () => {
  const detection = await detectUpsSource(fakeSource({ '1.3.6.1.2.1.1.1.0': 'un switch' }));
  assert.equal(detection.reader, null);
  assert.deepEqual(detection.declined, ['synology', 'rfc1628', 'apc']);
  assert.deepEqual(detection.failed, []);
});

test('🔴 un appareil injoignable lève, au lieu de se faire passer pour « pas un onduleur »', async () => {
  // Confondre les deux envoie l'utilisateur chercher un problème de MIB alors que sa
  // communauté SNMP est fausse — ou l'inverse. Seul le device sait ce que vaut une
  // injoignabilité (plan §3.8), donc l'erreur doit lui parvenir.
  await assert.rejects(() => detectUpsSource(unreachableSource()), /injoignable/);
});

test('une source qui échoue n\'empêche pas les suivantes de répondre', async () => {
  let calls = 0;
  const flaky = {
    async get(oids: string[]) {
      calls += 1;
      if (calls === 1) throw new Error('timeout sur la première sonde');
      return fakeSource(APC).get(oids);
    },
  };
  const detection = await detectUpsSource(flaky);
  assert.equal(detection.reader?.source, 'apc');
  assert.equal(detection.failed.length, 1);
  assert.equal(detection.failed[0]!.source, 'synology');
});

test('readUpsSnapshot assemble un snapshot complet et marque sa provenance', async () => {
  const reader = readerForSource('rfc1628')!;
  const snapshot = await readUpsSnapshot(reader, fakeSource({
    ...RFC1628,
    [RFC1628_UPS_OID.identManufacturer]: 'EATON',
    [RFC1628_UPS_OID.identModel]: '5PX 1500',
    [RFC1628_UPS_OID.estimatedChargeRemaining]: 87,
    [RFC1628_UPS_OID.estimatedMinutesRemaining]: 25,
    [RFC1628_UPS_OID.batteryVoltage]: 273,
    '1.3.6.1.2.1.33.1.3.3.1.3.1': 230,
  }));
  assert.equal(snapshot.source, 'rfc1628');
  assert.equal(snapshot.manufacturer, 'EATON');
  assert.equal(snapshot.status, 'normal');
  assert.equal(snapshot.batteryCharge, 87);
  assert.equal(snapshot.runtimeMinutes, 25);
  assert.equal(snapshot.batteryVoltage, 27.3);
  assert.equal(snapshot.inputVoltage, 230);
});

test('les trois lecteurs rendent la même forme, quel que soit le dialecte', async () => {
  // C'est tout l'intérêt du contrat commun : au-dessus de cette frontière, rien ne doit
  // pouvoir deviner de quelle MIB la valeur vient.
  const cases = [
    [readerForSource('synology')!, SYNOLOGY],
    [readerForSource('rfc1628')!, RFC1628],
    [readerForSource('apc')!, APC],
  ] as const;

  for (const [reader, values] of cases) {
    const snapshot = await readUpsSnapshot(reader, fakeSource(values));
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'alarmSummary', 'alarms', 'batteryCharge', 'batteryChargeLow', 'batteryTemperature', 'batteryVoltage',
      'inputVoltage', 'load', 'manufacturer', 'model', 'outputPower', 'outputVoltage',
      'runtimeLowMinutes', 'runtimeMinutes', 'serial', 'source', 'status',
    ], `forme divergente pour ${reader.source}`);
    assert.deepEqual(Object.keys(snapshot.alarms).sort(), ['batteryLow', 'onBattery', 'overload', 'replaceBattery']);
  }
});
