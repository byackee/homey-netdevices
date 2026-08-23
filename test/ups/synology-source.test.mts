import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SYNOLOGY_UPS_OID } from '../../lib/ups/synology-mib.mjs';
import { synologyUpsSource } from '../../lib/ups/reader.mjs';
import type { SnmpValue } from '../../lib/ups/snapshot.mjs';
import { fakeSource } from './fake-source.mjs';

/** Encode un flottant comme Synology le met sur le fil : `Opaque` propriétaire Net-SNMP. */
function opaqueFloat(value: number): Buffer {
  const buffer = Buffer.alloc(7);
  buffer[0] = 0x9f; buffer[1] = 0x78; buffer[2] = 0x04;
  buffer.writeFloatBE(value, 3);
  return buffer;
}

const ONLINE = {
  [SYNOLOGY_UPS_OID.deviceModel]: 'Eaton 3S 700',
  [SYNOLOGY_UPS_OID.deviceManufacturer]: 'EATON',
  [SYNOLOGY_UPS_OID.deviceSerial]: 'G1234X56789',
  [SYNOLOGY_UPS_OID.infoStatus]: 'OL CHRG',
  [SYNOLOGY_UPS_OID.batteryChargeValue]: opaqueFloat(87.5),
  [SYNOLOGY_UPS_OID.batteryRuntimeValue]: 1500,
  [SYNOLOGY_UPS_OID.infoLoadValue]: opaqueFloat(23.5),
  [SYNOLOGY_UPS_OID.batteryChargeLow]: opaqueFloat(20),
  [SYNOLOGY_UPS_OID.batteryRuntimeLow]: 180,
  [SYNOLOGY_UPS_OID.batteryVoltageValue]: opaqueFloat(27.25),
  [SYNOLOGY_UPS_OID.batteryTemperature]: opaqueFloat(24.5),
} satisfies Record<string, SnmpValue>;

test('l\'adaptateur expose la part commune de la lecture Synology', async () => {
  const client = fakeSource(ONLINE);
  const identity = await synologyUpsSource.readIdentity(client);
  const live = await synologyUpsSource.readLive(client);

  assert.equal(synologyUpsSource.source, 'synology');
  assert.equal(identity.model, 'Eaton 3S 700');
  assert.equal(identity.serial, 'G1234X56789', 'Synology est la seule source à donner un vrai numéro de série');
  assert.equal(live.status, 'normal');
  assert.equal(live.batteryCharge, 87.5, 'l\'Opaque Float est décodé');
  assert.equal(live.runtimeMinutes, 25, '1500 s ⇒ 25 min, et pas 1500 ni 0,25');
  assert.equal(live.load, 23.5);
  assert.deepEqual(live.alarms, { onBattery: false, batteryLow: false, overload: false, replaceBattery: false });
});

test('l\'adaptateur ne laisse fuir ni les jetons NUT ni les mesures hors contrat', async () => {
  const live = await synologyUpsSource.readLive(fakeSource(ONLINE));
  assert.deepEqual(Object.keys(live).sort(), ['alarms', 'batteryCharge', 'load', 'runtimeMinutes', 'status']);
});

test('🔴 ce que Synology ne relaie pas reste null', async () => {
  // DSM ne publie ni tension d'entrée, ni tension de sortie, ni puissance : NUT les
  // connaît parfois, la MIB non. Le lot 4 s'en sert pour ne pas déclarer une capability
  // qu'il ne saurait pas remplir — `removeCapability` détruit l'historique Insights.
  const detail = await synologyUpsSource.readDetail(fakeSource(ONLINE));
  assert.equal(detail.inputVoltage, null);
  assert.equal(detail.outputVoltage, null);
  assert.equal(detail.outputPower, null);
  assert.equal(detail.batteryVoltage, 27.25, 'la tension **batterie**, elle, existe');
  assert.equal(detail.batteryChargeLow, 20);
  assert.equal(detail.runtimeLowMinutes, 3, 'le seuil LB est en secondes lui aussi');
});

test('la température de l\'onduleur prend le relais de celle de la batterie', async () => {
  const withBattery = await synologyUpsSource.readDetail(fakeSource(ONLINE));
  assert.equal(withBattery.batteryTemperature, 24.5);

  const source = fakeSource({
    ...ONLINE,
    [SYNOLOGY_UPS_OID.batteryTemperature]: null,
    [SYNOLOGY_UPS_OID.infoTemperature]: opaqueFloat(31),
  });
  assert.equal((await synologyUpsSource.readDetail(source)).batteryTemperature, 31);
});

test('coupure de courant : "OB LB" traverse l\'adaptateur intact', async () => {
  const live = await synologyUpsSource.readLive(fakeSource({
    ...ONLINE,
    [SYNOLOGY_UPS_OID.infoStatus]: 'OB LB',
    [SYNOLOGY_UPS_OID.batteryChargeValue]: opaqueFloat(18),
  }));
  assert.equal(live.status, 'battery');
  assert.equal(live.alarms.onBattery, true);
  assert.equal(live.alarms.batteryLow, true);
  assert.equal(live.batteryCharge, 18);
});

test('la sonde reconnaît un NAS qui relaie un onduleur, et refuse celui qui n\'en a pas', async () => {
  assert.equal(await synologyUpsSource.probe(fakeSource(ONLINE)), true);
  assert.equal(await synologyUpsSource.probe(fakeSource({})), false, 'un NAS sans onduleur ne publie pas la branche');
  assert.equal(
    await synologyUpsSource.probe(fakeSource({ [SYNOLOGY_UPS_OID.infoStatus]: '   ' })),
    false,
    'une chaîne vide ne prouve rien',
  );
});

test('🔴 un OID absent rend null, jamais 0', async () => {
  const empty = fakeSource({});
  const live = await synologyUpsSource.readLive(empty);
  assert.equal(live.batteryCharge, null);
  assert.equal(live.runtimeMinutes, null);
  assert.equal(live.status, 'unknown', 'pas de statut ⇒ inconnu, pas « normal »');
});
