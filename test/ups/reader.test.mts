import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SYNOLOGY_UPS_OID } from '../../lib/ups/synology-mib.mjs';
import { SynologyUpsReader, secondsToMinutes, type SnmpValue } from '../../lib/ups/reader.mjs';

/** Encode un flottant comme Synology le met sur le fil : `Opaque` propriétaire Net-SNMP. */
function opaqueFloat(value: number): Buffer {
  const buffer = Buffer.alloc(7);
  buffer[0] = 0x9f; buffer[1] = 0x78; buffer[2] = 0x04;
  buffer.writeFloatBE(value, 3);
  return buffer;
}

/**
 * Agent factice.
 *
 * Un OID absent du dictionnaire est absent de la réponse — c'est ce que fait un agent
 * qui ne connaît pas l'objet, et ce cas-là doit rendre `null`, pas planter.
 */
function fakeSource(values: Record<string, SnmpValue>) {
  const asked: string[][] = [];
  return {
    asked,
    async get(oids: string[]): Promise<Map<string, SnmpValue>> {
      asked.push(oids);
      const out = new Map<string, SnmpValue>();
      for (const oid of oids) {
        if (Object.prototype.hasOwnProperty.call(values, oid)) out.set(oid, values[oid]!);
      }
      return out;
    },
  };
}

/**
 * Fixture « onduleur sain », avec des valeurs choisies pour que les conversions soient
 * **discernables**. 1500 s d'autonomie : 25 min en secondes, 0,25 min en centièmes de
 * seconde, 1500 sans conversion. Une fixture à 60 laisserait les trois se confondre
 * et le test ne prouverait rien (plan §8.5).
 */
const ONLINE = {
  [SYNOLOGY_UPS_OID.deviceModel]: 'Eaton 3S 700',
  [SYNOLOGY_UPS_OID.deviceManufacturer]: 'EATON',
  [SYNOLOGY_UPS_OID.deviceSerial]: '  G1234X56789  ',
  [SYNOLOGY_UPS_OID.infoStatus]: 'OL CHRG',
  [SYNOLOGY_UPS_OID.infoAlarm]: '',
  [SYNOLOGY_UPS_OID.batteryChargeValue]: opaqueFloat(87.5),
  [SYNOLOGY_UPS_OID.batteryRuntimeValue]: 1500,
  [SYNOLOGY_UPS_OID.infoLoadValue]: opaqueFloat(23.5),
  [SYNOLOGY_UPS_OID.batteryChargeLow]: opaqueFloat(20),
  [SYNOLOGY_UPS_OID.batteryRuntimeLow]: 180,
  [SYNOLOGY_UPS_OID.batteryVoltageValue]: opaqueFloat(27.25),
  [SYNOLOGY_UPS_OID.batteryVoltageNominal]: opaqueFloat(24),
  [SYNOLOGY_UPS_OID.batteryCapacity]: opaqueFloat(7.25),
  [SYNOLOGY_UPS_OID.batteryCurrent]: opaqueFloat(-0.5),
  [SYNOLOGY_UPS_OID.batteryTemperature]: opaqueFloat(24.5),
} satisfies Record<string, SnmpValue>;

test('la fixture d\'autonomie distingue bien les trois conversions candidates', () => {
  // Garde-fou sur le test lui-même : si quelqu'un ramène cette valeur à 60, ÷60, ÷6000
  // et « rien » deviennent indiscernables et la suite passe au vert sans rien prouver.
  const raw = ONLINE[SYNOLOGY_UPS_OID.batteryRuntimeValue];
  const candidates = new Set([raw, raw / 60, raw / 6000]);
  assert.equal(candidates.size, 3, 'la fixture doit rendre les trois conversions distinctes');
});

test('l\'autonomie Synology est normalisée de secondes en minutes', async () => {
  const snapshot = await new SynologyUpsReader(fakeSource(ONLINE)).read();
  assert.equal(snapshot.runtimeMinutes, 25);
  assert.notEqual(snapshot.runtimeMinutes, 1500, 'les secondes ne doivent pas remonter telles quelles');
  assert.notEqual(snapshot.runtimeMinutes, 0.25, 'ce ne sont pas des centièmes de seconde');
  assert.equal(snapshot.runtimeLowMinutes, 3, 'le seuil LB est en secondes lui aussi');
});

test('secondsToMinutes arrondit au dixième et refuse l\'impossible', () => {
  assert.equal(secondsToMinutes(0), 0);
  assert.equal(secondsToMinutes(90), 1.5);
  assert.equal(secondsToMinutes(1000), 16.7);
  assert.equal(secondsToMinutes(null), null);
  assert.equal(secondsToMinutes(-1), null, 'une autonomie négative n\'existe pas');
  assert.equal(secondsToMinutes(Number.NaN), null);
});

test('un onduleur sain donne un snapshot complet', async () => {
  const snapshot = await new SynologyUpsReader(fakeSource(ONLINE)).read();
  assert.equal(snapshot.model, 'Eaton 3S 700');
  assert.equal(snapshot.manufacturer, 'EATON');
  assert.equal(snapshot.serial, 'G1234X56789', 'la DisplayString est débarrassée de ses espaces');
  assert.equal(snapshot.status, 'normal');
  assert.deepEqual(snapshot.nut.flags, ['OL', 'CHRG']);
  assert.equal(snapshot.batteryCharge, 87.5, 'l\'Opaque Float est décodé');
  assert.equal(snapshot.load, 23.5);
  assert.equal(snapshot.batteryVoltage, 27.25);
  assert.equal(snapshot.batteryCapacity, 7.25);
  assert.equal(snapshot.batteryCurrent, -0.5, 'le courant est signé en décharge');
  assert.equal(snapshot.batteryTemperature, 24.5);
  assert.equal(snapshot.alarmText, null, 'une alarme vide n\'est pas une alarme');
  assert.deepEqual(snapshot.alarms, {
    onBattery: false, batteryLow: false, overload: false, replaceBattery: false,
  });
});

test('coupure de courant : "OB LB" lève les bonnes alarmes', async () => {
  const source = fakeSource({
    ...ONLINE,
    [SYNOLOGY_UPS_OID.infoStatus]: 'OB LB',
    [SYNOLOGY_UPS_OID.batteryChargeValue]: opaqueFloat(18),
    [SYNOLOGY_UPS_OID.batteryRuntimeValue]: 174,
    [SYNOLOGY_UPS_OID.infoAlarm]: 'Battery low',
  });
  const live = await new SynologyUpsReader(source).readLive();
  assert.equal(live.status, 'battery');
  assert.equal(live.alarms.onBattery, true);
  assert.equal(live.alarms.batteryLow, true);
  assert.equal(live.batteryCharge, 18);
  assert.equal(live.runtimeMinutes, 2.9, '174 s ⇒ 2,9 min');
  assert.equal(live.alarmText, 'Battery low');
});

test('🔴 un OID absent rend null, jamais 0', async () => {
  // Le scénario qui a coûté une session de debug : 0 % de batterie déclenche
  // alarm_battery ET alarm_ups_onbattery — une fausse alerte de coupure, la nuit.
  const snapshot = await new SynologyUpsReader(fakeSource({})).read();
  assert.equal(snapshot.batteryCharge, null);
  assert.equal(snapshot.runtimeMinutes, null);
  assert.equal(snapshot.load, null);
  assert.equal(snapshot.batteryTemperature, null);
  assert.equal(snapshot.upsTemperature, null);
  assert.equal(snapshot.model, null);
  assert.equal(snapshot.status, 'unknown', 'pas de statut ⇒ inconnu, pas « normal »');
  assert.equal(snapshot.alarms.onBattery, false);
});

test('un varbind explicitement null rend null lui aussi', async () => {
  const source = fakeSource({ ...ONLINE, [SYNOLOGY_UPS_OID.batteryChargeValue]: null });
  const live = await new SynologyUpsReader(source).readLive();
  assert.equal(live.batteryCharge, null);
});

test('une batterie réellement à 0 % reste 0, et se distingue de l\'absence', async () => {
  const source = fakeSource({ ...ONLINE, [SYNOLOGY_UPS_OID.batteryChargeValue]: opaqueFloat(0) });
  const live = await new SynologyUpsReader(source).readLive();
  assert.equal(live.batteryCharge, 0);
  assert.notEqual(live.batteryCharge, null);
});

test('une mesure hors bornes rend null plutôt qu\'une valeur ramenée dans l\'intervalle', async () => {
  const source = fakeSource({
    ...ONLINE,
    [SYNOLOGY_UPS_OID.batteryChargeValue]: opaqueFloat(1e30),
    [SYNOLOGY_UPS_OID.infoLoadValue]: opaqueFloat(-5),
  });
  const live = await new SynologyUpsReader(source).readLive();
  assert.equal(live.batteryCharge, null, 'ramener à 100 % masquerait le décodage raté');
  assert.equal(live.load, null, 'ramener à 0 % masquerait le décodage raté');
});

test('un tampon qui n\'est pas un Opaque Float rend null', async () => {
  const source = fakeSource({
    ...ONLINE,
    [SYNOLOGY_UPS_OID.batteryChargeValue]: Buffer.from('deadbeef', 'hex'),
  });
  const live = await new SynologyUpsReader(source).readLive();
  assert.equal(live.batteryCharge, null);
});

test('les groupes de poll n\'interrogent que leurs propres OID', async () => {
  const source = fakeSource(ONLINE);
  const reader = new SynologyUpsReader(source);
  await reader.readLive();
  assert.deepEqual(source.asked[0], [
    SYNOLOGY_UPS_OID.infoStatus,
    SYNOLOGY_UPS_OID.infoAlarm,
    SYNOLOGY_UPS_OID.batteryChargeValue,
    SYNOLOGY_UPS_OID.batteryRuntimeValue,
    SYNOLOGY_UPS_OID.infoLoadValue,
  ], 'le groupe rapide reste court : il tourne toutes les dix secondes');
  await reader.readIdentity();
  assert.equal(source.asked[1]!.length, 3);
});

test('une erreur de transport remonte au lieu d\'être avalée', async () => {
  const source = {
    async get(): Promise<Map<string, SnmpValue>> { throw new Error('injoignable'); },
  };
  await assert.rejects(() => new SynologyUpsReader(source).read(), /injoignable/);
});

test('le lecteur n\'invente pas de précision : le float32 arrive tel quel', async () => {
  // 27,2 n'est pas représentable en IEEE754 simple précision : l'agent envoie
  // 27.200000762939453 et c'est bien cette valeur-là qui a été mesurée à l'octet près.
  // Arrondir ici serait fabriquer une précision qu'on n'a pas ; l'arrondi d'affichage
  // appartient au mapping des capabilities (lot 4), qui sait combien de décimales
  // chaque capability montre. Ce test épingle le choix pour qu'il ne soit pas « corrigé ».
  const source = fakeSource({ ...ONLINE, [SYNOLOGY_UPS_OID.batteryVoltageValue]: opaqueFloat(27.2) });
  const detail = await new SynologyUpsReader(source).readDetail();
  assert.equal(detail.batteryVoltage, 27.200000762939453);
});
