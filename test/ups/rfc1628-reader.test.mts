import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  RFC1628_ALARM,
  RFC1628_ALARM_COLUMN,
  RFC1628_INPUT_COLUMN,
  RFC1628_OUTPUT_COLUMN,
  RFC1628_TENTHS,
  RFC1628_UPS_OID,
  decodeAlarmOid,
  rfc1628Column,
} from '../../lib/ups/rfc1628-mib.mjs';
import {
  Rfc1628UpsReader,
  outputSourceToStatus,
  rfc1628UpsSource,
  scanRfc1628Alarms,
} from '../../lib/ups/rfc1628-reader.mjs';
import type { SnmpValue } from '../../lib/ups/snapshot.mjs';
import { fakeSource } from './fake-source.mjs';

const IN_VOLTAGE = rfc1628Column(RFC1628_INPUT_COLUMN.voltage);
const OUT_VOLTAGE = rfc1628Column(RFC1628_OUTPUT_COLUMN.voltage);
const OUT_POWER = rfc1628Column(RFC1628_OUTPUT_COLUMN.power);
const OUT_LOAD = rfc1628Column(RFC1628_OUTPUT_COLUMN.percentLoad);
const ALARM_1 = rfc1628Column(RFC1628_ALARM_COLUMN.descr, 1);
const ALARM_2 = rfc1628Column(RFC1628_ALARM_COLUMN.descr, 2);

/**
 * Fixture « onduleur sain ».
 *
 * Les valeurs sont choisies pour que chaque conversion soit **discernable de son
 * absence** (plan §8.5) :
 * - autonomie 25 : ≠ 25/60 ≠ 25/6000, donc « déjà en minutes » se prouve ;
 * - tension batterie 273 : ≠ 27,3 ≠ 2730, donc les décivolts se prouvent ;
 * - tension d'entrée 230 **et** sortie 231 : deux valeurs distinctes, donc ni un
 *   `fromTenths` de trop (23) ni une inversion entrée/sortie ne passent inaperçus.
 */
const ONLINE = {
  [RFC1628_UPS_OID.identManufacturer]: '  EATON  ',
  [RFC1628_UPS_OID.identModel]: '5PX 1500',
  [RFC1628_UPS_OID.outputSource]: 3,
  [RFC1628_UPS_OID.batteryStatus]: 2,
  [RFC1628_UPS_OID.estimatedChargeRemaining]: 87,
  [RFC1628_UPS_OID.estimatedMinutesRemaining]: 25,
  [RFC1628_UPS_OID.alarmsPresent]: 0,
  [OUT_LOAD]: 42,
  [IN_VOLTAGE]: 230,
  [OUT_VOLTAGE]: 231,
  [OUT_POWER]: 145,
  [RFC1628_UPS_OID.batteryVoltage]: 273,
  [RFC1628_UPS_OID.batteryTemperature]: 26,
} satisfies Record<string, SnmpValue>;

test('🔴 la fixture rend les conversions discernables', () => {
  // Sans ce garde-fou, ramener l'autonomie à 60 ou la tension batterie à 10 rendrait
  // « ÷1 », « ÷60 » et « ÷6000 » indistinguables, et la suite passerait au vert sans
  // rien prouver du tout.
  const runtime = ONLINE[RFC1628_UPS_OID.estimatedMinutesRemaining];
  assert.equal(new Set([runtime, runtime / 60, runtime / 6000]).size, 3);
  const voltage = ONLINE[RFC1628_UPS_OID.batteryVoltage];
  assert.equal(new Set([voltage, voltage / 10, voltage * 10]).size, 3);
  assert.notEqual(ONLINE[IN_VOLTAGE], ONLINE[OUT_VOLTAGE], 'entrée et sortie doivent différer');
});

test('l\'autonomie RFC 1628 est déjà en minutes : aucune conversion', async () => {
  const live = await rfc1628UpsSource.readLive(fakeSource(ONLINE));
  assert.equal(live.runtimeMinutes, 25);
  assert.notEqual(live.runtimeMinutes, 25 / 60, 'ce ne sont pas des secondes');
  assert.notEqual(live.runtimeMinutes, 25 / 6000, 'ce ne sont pas des centièmes de seconde');
});

test('🔴 les tensions AC sont en volts entiers, la tension batterie en décivolts', async () => {
  const detail = await rfc1628UpsSource.readDetail(fakeSource(ONLINE));
  assert.equal(detail.inputVoltage, 230, 'un secteur à 230 V reste 230 V');
  assert.notEqual(detail.inputVoltage, 23, 'un fromTenths de trop donnerait 23 V, crédible et faux');
  assert.equal(detail.outputVoltage, 231, 'et la sortie n\'est pas l\'entrée');
  assert.equal(detail.batteryVoltage, 27.3, '273 décivolts font 27,3 V');
  assert.notEqual(detail.batteryVoltage, 273, 'les décivolts ne remontent pas tels quels');
  assert.equal(detail.outputPower, 145);
  assert.equal(detail.batteryTemperature, 26);
});

test('la liste des objets en dixièmes exclut explicitement les tensions AC', () => {
  const tenths = new Set<string>(RFC1628_TENTHS);
  assert.ok(tenths.has(RFC1628_UPS_OID.batteryVoltage), 'la tension batterie est en dixièmes');
  assert.ok(!tenths.has(RFC1628_INPUT_COLUMN.voltage), 'la tension d\'entrée ne l\'est pas');
  assert.ok(!tenths.has(RFC1628_OUTPUT_COLUMN.voltage), 'la tension de sortie non plus');
});

test('🔴 les tables s\'indexent à 1, jamais à 0', async () => {
  const source = fakeSource(ONLINE);
  await rfc1628UpsSource.readDetail(source);
  const asked = source.asked[0]!;
  assert.ok(asked.includes('1.3.6.1.2.1.33.1.3.3.1.3.1'), 'la ligne 1 est interrogée');
  assert.ok(!asked.includes('1.3.6.1.2.1.33.1.3.3.1.3.0'), 'l\'index 0 n\'existe pas dans cette MIB');
  assert.equal(rfc1628Column(RFC1628_INPUT_COLUMN.voltage), '1.3.6.1.2.1.33.1.3.3.1.3.1');
});

test('un onduleur triphasé peut être lu sur une autre ligne', async () => {
  const source = fakeSource({ ...ONLINE, [rfc1628Column(RFC1628_INPUT_COLUMN.voltage, 3)]: 229 });
  const detail = await new Rfc1628UpsReader({ line: 3 }).readDetail(source);
  assert.equal(detail.inputVoltage, 229);
});

test('un onduleur sain donne une identité, sans inventer de numéro de série', async () => {
  const identity = await rfc1628UpsSource.readIdentity(fakeSource(ONLINE));
  assert.equal(identity.manufacturer, 'EATON', 'la DisplayString est débarrassée de ses espaces');
  assert.equal(identity.model, '5PX 1500');
  assert.equal(identity.serial, null, 'la RFC 1628 n\'a pas d\'objet de numéro de série');
});

test('upsOutputSource porte le statut, et « other » n\'est pas « normal »', () => {
  assert.equal(outputSourceToStatus(3), 'normal');
  assert.equal(outputSourceToStatus(5), 'battery');
  assert.equal(outputSourceToStatus(4), 'bypass');
  assert.equal(outputSourceToStatus(6), 'booster');
  assert.equal(outputSourceToStatus(7), 'reducer');
  assert.equal(outputSourceToStatus(2), 'off');
  assert.equal(outputSourceToStatus(1), 'unknown', '« other » veut dire « je ne sais pas »');
  assert.equal(outputSourceToStatus(99), 'unknown', 'hors énumération ⇒ inconnu');
  assert.equal(outputSourceToStatus(null), 'unknown', 'pas de réponse ⇒ inconnu, pas « normal »');
});

test('coupure de courant : upsOutputSource et upsBatteryStatus suffisent', async () => {
  const live = await rfc1628UpsSource.readLive(fakeSource({
    ...ONLINE,
    [RFC1628_UPS_OID.outputSource]: 5,
    [RFC1628_UPS_OID.batteryStatus]: 3,
    [RFC1628_UPS_OID.estimatedChargeRemaining]: 18,
    [RFC1628_UPS_OID.estimatedMinutesRemaining]: 3,
  }));
  assert.equal(live.status, 'battery');
  assert.equal(live.alarms.onBattery, true);
  assert.equal(live.alarms.batteryLow, true);
  assert.equal(live.batteryCharge, 18);
  assert.equal(live.runtimeMinutes, 3);
});

test('la table d\'alarmes ajoute la surcharge et la batterie à remplacer', async () => {
  const live = await rfc1628UpsSource.readLive(fakeSource({
    ...ONLINE,
    [RFC1628_UPS_OID.alarmsPresent]: 2,
    [ALARM_1]: RFC1628_ALARM.outputOverload,
    [ALARM_2]: RFC1628_ALARM.batteryBad,
  }));
  assert.equal(live.alarms.overload, true);
  assert.equal(live.alarms.replaceBattery, true);
  assert.equal(live.status, 'normal', 'une surcharge ne fait pas passer sur batterie');
});

test('🔴 un OID d\'alarme inconnu ne fait pas échouer la lecture', async () => {
  // APC et Eaton définissent leurs propres alarmes sous leur PEN. Perdre la charge
  // batterie parce qu'un constructeur a inventé un code serait échanger une gêne
  // contre une panne (annexe A, piège n°5).
  const live = await rfc1628UpsSource.readLive(fakeSource({
    ...ONLINE,
    [RFC1628_UPS_OID.alarmsPresent]: 2,
    [ALARM_1]: '1.3.6.1.4.1.318.1.1.1.99.42',
    [ALARM_2]: RFC1628_ALARM.onBattery,
  }));
  assert.equal(live.alarms.onBattery, true, 'l\'alarme RFC voisine reste décodée');
  assert.equal(live.batteryCharge, 87, 'et les mesures arrivent quand même');
});

test('scanRfc1628Alarms sépare le connu de l\'étranger et signale la troncature', () => {
  const scan = scanRfc1628Alarms(
    [RFC1628_ALARM.onBattery, '1.3.6.1.4.1.318.1.99', RFC1628_ALARM.onBattery, null],
    9,
  );
  assert.deepEqual(scan.present, ['onBattery'], 'les doublons sont écrasés');
  assert.deepEqual(scan.foreign, ['1.3.6.1.4.1.318.1.99']);
  assert.equal(scan.count, 9);
  assert.equal(scan.truncated, true, 'l\'agent annonce plus d\'alarmes que la fenêtre sondée');
});

test('decodeAlarmOid tolère le point initial et refuse l\'inconnu', () => {
  assert.equal(decodeAlarmOid('.1.3.6.1.2.1.33.1.6.3.2'), 'onBattery');
  assert.equal(decodeAlarmOid('1.3.6.1.2.1.33.1.6.3.8'), 'outputOverload');
  assert.equal(decodeAlarmOid('1.3.6.1.4.1.318.1.1'), null);
  assert.equal(decodeAlarmOid(null), null);
});

test('🔴 un OID absent rend null, jamais 0', async () => {
  const empty = fakeSource({});
  const live = await rfc1628UpsSource.readLive(empty);
  const detail = await rfc1628UpsSource.readDetail(empty);
  assert.equal(live.batteryCharge, null);
  assert.equal(live.runtimeMinutes, null);
  assert.equal(live.load, null);
  assert.equal(live.status, 'unknown', 'pas de statut ⇒ inconnu, pas « normal »');
  assert.deepEqual(live.alarms, { onBattery: false, batteryLow: false, overload: false, replaceBattery: false });
  assert.equal(detail.inputVoltage, null);
  assert.equal(detail.batteryVoltage, null);
});

test('une batterie réellement à 0 % reste 0, et se distingue de l\'absence', async () => {
  const live = await rfc1628UpsSource.readLive(fakeSource({
    ...ONLINE,
    [RFC1628_UPS_OID.estimatedChargeRemaining]: 0,
  }));
  assert.equal(live.batteryCharge, 0);
  assert.notEqual(live.batteryCharge, null);
});

test('une mesure hors bornes rend null plutôt qu\'une valeur rabotée', async () => {
  const live = await rfc1628UpsSource.readLive(fakeSource({
    ...ONLINE,
    [RFC1628_UPS_OID.estimatedChargeRemaining]: 120,
    [OUT_LOAD]: 500,
  }));
  assert.equal(live.batteryCharge, null, 'ramener à 100 % masquerait le problème');
  assert.equal(live.load, null, 'la RFC borne la charge à 200 %');
});

test('un Opaque Float sur une MIB d\'entiers rend null, pas une valeur inventée', async () => {
  const opaque = Buffer.from('9f780442f60000', 'hex'); // ce que Synology mettrait sur le fil
  const live = await rfc1628UpsSource.readLive(fakeSource({
    ...ONLINE,
    [RFC1628_UPS_OID.estimatedChargeRemaining]: opaque,
  }));
  assert.equal(live.batteryCharge, null, 'la RFC 1628 n\'emploie pas d\'Opaque Float');
});

test('la sonde reconnaît un onduleur RFC et refuse un appareil muet', async () => {
  assert.equal(await rfc1628UpsSource.probe(fakeSource(ONLINE)), true);
  assert.equal(await rfc1628UpsSource.probe(fakeSource({})), false);
  assert.equal(
    await rfc1628UpsSource.probe(fakeSource({ [RFC1628_UPS_OID.outputSource]: 42 })),
    false,
    'une valeur hors énumération ne prouve rien',
  );
  assert.equal(
    await rfc1628UpsSource.probe(fakeSource({ [RFC1628_UPS_OID.batteryStatus]: 2 })),
    true,
    'upsBatteryStatus seul suffit : upsOutputSource manque sur certaines cartes',
  );
});

test('le groupe rapide reste court : il tourne toutes les dix secondes', async () => {
  const source = fakeSource(ONLINE);
  await rfc1628UpsSource.readLive(source);
  const asked = source.asked[0]!;
  assert.ok(!asked.includes(IN_VOLTAGE), 'les tensions appartiennent au groupe lent');
  assert.ok(!asked.includes(RFC1628_UPS_OID.identModel), 'l\'identité ne bouge pas');
  assert.ok(asked.includes(RFC1628_UPS_OID.outputSource));
});

test('une erreur de transport remonte au lieu d\'être avalée', async () => {
  const source = { async get(): Promise<Map<string, SnmpValue>> { throw new Error('injoignable'); } };
  await assert.rejects(() => rfc1628UpsSource.readLive(source), /injoignable/);
});
