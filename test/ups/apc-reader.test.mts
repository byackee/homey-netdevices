import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  APC_OUTPUT_STATUS,
  APC_TEMPERATURE_UNSUPPORTED,
  APC_TIMETICKS_UNSUPPORTED,
  APC_UPS_OID,
} from '../../lib/ups/apc-mib.mjs';
import {
  APC_TEMPERATURE_PLAUSIBLE_MAX,
  apcAlarms,
  apcRuntimeMinutes,
  apcTemperature,
  apcUpsSource,
  outputStatusToUpsStatus,
} from '../../lib/ups/apc-reader.mjs';
import type { SnmpValue } from '../../lib/ups/snapshot.mjs';
import { fakeSource } from './fake-source.mjs';

/**
 * Fixture « onduleur sain ».
 *
 * Valeurs choisies discernables (plan §8.5) :
 * - autonomie 150 000 TimeTicks : ÷6000 = 25 min, ÷60 = 2500, brut = 150 000 ;
 * - charge 873 dixièmes **et** 87 % entiers : deux objets pour la même batterie, donc
 *   confondre les deux se voit (87,3 ≠ 87 ≠ 873) ;
 * - charge de sortie 235 dixièmes **et** 23 % entiers, même raison.
 */
const ONLINE = {
  [APC_UPS_OID.basicIdentModel]: '  Smart-UPS 750  ',
  [APC_UPS_OID.basicOutputStatus]: APC_OUTPUT_STATUS.onLine,
  [APC_UPS_OID.basicBatteryStatus]: 2,
  [APC_UPS_OID.highPrecBatteryCapacity]: 873,
  [APC_UPS_OID.advBatteryCapacity]: 87,
  [APC_UPS_OID.advBatteryRunTimeRemaining]: 150_000,
  [APC_UPS_OID.highPrecOutputLoad]: 235,
  [APC_UPS_OID.advOutputLoad]: 23,
  [APC_UPS_OID.advInputLineVoltage]: 230,
  [APC_UPS_OID.advBatteryTemperature]: 27,
} satisfies Record<string, SnmpValue>;

test('🔴 la fixture rend les conversions discernables', () => {
  const ticks = ONLINE[APC_UPS_OID.advBatteryRunTimeRemaining];
  assert.equal(new Set([ticks, ticks / 60, ticks / 6000]).size, 3);
  const charge = ONLINE[APC_UPS_OID.highPrecBatteryCapacity];
  assert.equal(new Set([charge, charge / 10, ONLINE[APC_UPS_OID.advBatteryCapacity]]).size, 3);
});

test('🔴 l\'autonomie APC est en TimeTicks : ÷6000 pour des minutes', async () => {
  const live = await apcUpsSource.readLive(fakeSource(ONLINE));
  assert.equal(live.runtimeMinutes, 25);
  assert.notEqual(live.runtimeMinutes, 2500, 'ce ne sont pas des secondes');
  assert.notEqual(live.runtimeMinutes, 150_000, 'ce ne sont pas déjà des minutes');
});

test('🔴 la sentinelle TimeTicks rend null, pas 81 ans d\'autonomie', async () => {
  // 4294967295 ÷ 6000 = 715 827 minutes. APC répond ça au lieu de noSuchObject : la
  // requête réussit, la valeur est un entier valide, rien ne la distingue d'une mesure.
  const live = await apcUpsSource.readLive(fakeSource({
    ...ONLINE,
    [APC_UPS_OID.advBatteryRunTimeRemaining]: APC_TIMETICKS_UNSUPPORTED,
  }));
  assert.equal(live.runtimeMinutes, null);
  assert.notEqual(live.runtimeMinutes, 715_827.5);
  assert.equal(apcRuntimeMinutes(APC_TIMETICKS_UNSUPPORTED), null);
  assert.equal(apcRuntimeMinutes(150_000), 25);
});

test('🔴 la sentinelle de température rend null, pas une batterie à 255 °C', async () => {
  const detail = await apcUpsSource.readDetail(fakeSource({
    ...ONLINE,
    [APC_UPS_OID.advBatteryTemperature]: APC_TEMPERATURE_UNSUPPORTED,
  }));
  assert.equal(detail.batteryTemperature, null);
  assert.equal(apcTemperature(APC_TEMPERATURE_UNSUPPORTED), null);
  assert.equal(apcTemperature(27), 27);
  assert.equal(apcTemperature(0), 0, 'zéro degré est une mesure, pas une absence');
  assert.equal(apcTemperature(-5), -5, 'et une température négative aussi');
});

test('🔴 la sentinelle de température ne doit pas dépendre du bornage', () => {
  // Constat d'une passe de mutation : supprimer le test de sentinelle ne fait tomber
  // aucun test aujourd'hui, parce que 255 dépasse déjà la borne de plausibilité. Les deux
  // filets se recouvrent, et c'est très bien — mais le jour où quelqu'un élargira la
  // borne, la sentinelle redeviendra seule responsable sans que personne ne le remarque.
  // Ce test tombe ce jour-là, et c'est tout ce qu'on lui demande.
  assert.ok(
    APC_TEMPERATURE_UNSUPPORTED > APC_TEMPERATURE_PLAUSIBLE_MAX,
    'la borne de plausibilité ne doit jamais admettre la sentinelle',
  );
  assert.equal(apcTemperature(APC_TEMPERATURE_PLAUSIBLE_MAX), APC_TEMPERATURE_PLAUSIBLE_MAX);
  assert.equal(apcTemperature(APC_TEMPERATURE_PLAUSIBLE_MAX + 1), null);
});

test('🔴 la mesure haute précision est en dixièmes et prime sur l\'entière', async () => {
  const live = await apcUpsSource.readLive(fakeSource(ONLINE));
  assert.equal(live.batteryCharge, 87.3, '873 dixièmes de % font 87,3 %');
  assert.notEqual(live.batteryCharge, 873, 'les dixièmes ne remontent pas tels quels');
  assert.notEqual(live.batteryCharge, 87, 'et la version entière n\'est pas préférée');
  assert.equal(live.load, 23.5);
});

test('sans objet haute précision, la mesure entière prend le relais', async () => {
  const source = fakeSource({
    ...ONLINE,
    [APC_UPS_OID.highPrecBatteryCapacity]: null,
    [APC_UPS_OID.highPrecOutputLoad]: null,
  });
  const live = await apcUpsSource.readLive(source);
  assert.equal(live.batteryCharge, 87);
  assert.equal(live.load, 23);
});

test('🔴 une batterie haute précision réellement à 0 % reste 0, sans repli', async () => {
  // `??` et non `||` : avec `||`, un 0 légitime basculerait sur l'objet entier, et deux
  // sources pourraient se contredire au pire moment.
  const live = await apcUpsSource.readLive(fakeSource({
    ...ONLINE,
    [APC_UPS_OID.highPrecBatteryCapacity]: 0,
    [APC_UPS_OID.advBatteryCapacity]: 87,
  }));
  assert.equal(live.batteryCharge, 0);
  assert.notEqual(live.batteryCharge, 87, 'le repli ne doit pas écraser un vrai zéro');
});

test('la tension d\'entrée APC est en volts entiers', async () => {
  const detail = await apcUpsSource.readDetail(fakeSource(ONLINE));
  assert.equal(detail.inputVoltage, 230);
  assert.notEqual(detail.inputVoltage, 23, 'pas de division par dix ici');
});

test('les 28 valeurs d\'état se replient sur les 7 du vocabulaire commun', () => {
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.onLine), 'normal');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.ecoMode), 'normal');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.eConversion), 'normal');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.onBattery), 'battery');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.batteryDischargeSpotmode), 'battery');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.softwareBypass), 'bypass');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.hardwareFailureBypass), 'bypass');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.onSmartBoost), 'booster');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.onSmartTrim), 'reducer');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.off), 'off');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.rebooting), 'off');
  assert.equal(outputStatusToUpsStatus(APC_OUTPUT_STATUS.unknown), 'unknown');
  assert.equal(outputStatusToUpsStatus(99), 'unknown', 'hors énumération ⇒ inconnu');
  assert.equal(outputStatusToUpsStatus(null), 'unknown', 'pas de réponse ⇒ inconnu, pas « normal »');
});

test('les 28 valeurs sont toutes couvertes : aucune ne tombe par défaut', () => {
  // Le repli des 28 valeurs est écrit à la main ; ce test épingle qu'il est complet, pour
  // qu'un état APC réel n'atterrisse pas en « unknown » faute d'avoir été listé.
  for (const value of Object.values(APC_OUTPUT_STATUS)) {
    if (value === APC_OUTPUT_STATUS.unknown) continue;
    assert.notEqual(outputStatusToUpsStatus(value), 'unknown', `l'état ${value} n'est pas replié`);
  }
});

test('coupure de courant : onBattery lève l\'alarme et le statut', async () => {
  const live = await apcUpsSource.readLive(fakeSource({
    ...ONLINE,
    [APC_UPS_OID.basicOutputStatus]: APC_OUTPUT_STATUS.onBattery,
    [APC_UPS_OID.basicBatteryStatus]: 3,
  }));
  assert.equal(live.status, 'battery');
  assert.equal(live.alarms.onBattery, true);
  assert.equal(live.alarms.batteryLow, true);
});

test('🔴 un test de batterie programmé ne déclenche pas l\'alarme de coupure', async () => {
  // La charge est bien sur batterie — `status` le dit — mais couper les appareils non
  // essentiels de l'utilisateur pour un autotest hebdomadaire serait exactement la
  // fausse alerte nocturne que le plan §8.5 cherche à éviter.
  for (const status of [APC_OUTPUT_STATUS.onBatteryTest, APC_OUTPUT_STATUS.selfTest]) {
    const live = await apcUpsSource.readLive(fakeSource({ ...ONLINE, [APC_UPS_OID.basicOutputStatus]: status }));
    assert.equal(live.status, 'battery', 'la capability dit la vérité sur la source du courant');
    assert.equal(live.alarms.onBattery, false, 'mais le déclencheur de coupure reste au repos');
  }
});

test('la batterie en défaut ou absente demande un remplacement', () => {
  assert.equal(apcAlarms(2, 4).replaceBattery, true, 'batteryInFaultCondition');
  assert.equal(apcAlarms(2, 5).replaceBattery, true, 'noBatteryPresent');
  assert.equal(apcAlarms(2, 2).replaceBattery, false);
  assert.equal(apcAlarms(2, 2).overload, false, 'PowerNet vérifié n\'expose aucun objet de surcharge');
  assert.equal(apcAlarms(null, null).onBattery, false, 'aucune réponse ne lève aucune alarme');
});

test('l\'identité porte la marque, sans inventer de numéro de série', async () => {
  const identity = await apcUpsSource.readIdentity(fakeSource(ONLINE));
  assert.equal(identity.model, 'Smart-UPS 750', 'la DisplayString est débarrassée de ses espaces');
  assert.equal(identity.manufacturer, 'APC', 'le PEN 318 est APC par définition');
  assert.equal(identity.serial, null, 'l\'OID de série n\'a pas été vérifié en annexe');
});

test('🔴 un OID absent rend null, jamais 0', async () => {
  const empty = fakeSource({});
  const live = await apcUpsSource.readLive(empty);
  const detail = await apcUpsSource.readDetail(empty);
  assert.equal(live.batteryCharge, null);
  assert.equal(live.runtimeMinutes, null);
  assert.equal(live.load, null);
  assert.equal(live.status, 'unknown');
  assert.deepEqual(live.alarms, { onBattery: false, batteryLow: false, overload: false, replaceBattery: false });
  assert.equal(detail.inputVoltage, null);
  assert.equal(detail.batteryTemperature, null);
});

test('ce que PowerNet ne publie pas dans le sous-ensemble vérifié reste null', async () => {
  const detail = await apcUpsSource.readDetail(fakeSource(ONLINE));
  assert.equal(detail.outputVoltage, null);
  assert.equal(detail.outputPower, null);
  assert.equal(detail.batteryVoltage, null);
  assert.equal(detail.batteryChargeLow, null);
  assert.equal(detail.runtimeLowMinutes, null);
});

test('la sonde reconnaît un APC et refuse un appareil muet', async () => {
  assert.equal(await apcUpsSource.probe(fakeSource(ONLINE)), true);
  assert.equal(await apcUpsSource.probe(fakeSource({})), false);
  assert.equal(await apcUpsSource.probe(fakeSource({ [APC_UPS_OID.basicOutputStatus]: 99 })), false);
});

test('une erreur de transport remonte au lieu d\'être avalée', async () => {
  const source = { async get(): Promise<Map<string, SnmpValue>> { throw new Error('injoignable'); } };
  await assert.rejects(() => apcUpsSource.readLive(source), /injoignable/);
});
