import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SynologyUpsReader, type SnmpValue } from '../../lib/ups/reader.mjs';
import { SYNOLOGY_UPS_OID } from '../../lib/ups/synology-mib.mjs';
import { readerForSource } from '../../lib/ups/sources.mjs';

/**
 * Le premier onduleur réel que ce code ait lu.
 *
 * 🔴 Tous les autres fixtures de ce dossier sont écrits à la main **à partir de la même
 * lecture de la MIB que l'app**. Ils prouvent que le décodage est cohérent avec lui-même,
 * jamais qu'il est juste. Ceux-ci sont les octets bruts d'un `snmpwalk` sur un
 * **CyberPower VP700ELCD relié en USB à un Synology**, rapportés par un utilisateur —
 * la seule chose ici qui puisse contredire l'app.
 *
 * Ils l'ont fait : la branche `upsInput` / `upsOutput` existait et l'app ne la lisait pas,
 * parce que l'inventaire d'origine n'avait retenu que les objets recoupés par deux sources
 * indépendantes — deux sources qui s'arrêtaient toutes deux au groupe batterie.
 */

/** Le relevé, tel quel. Les `Opaque` sont recopiés octet pour octet. */
const bytes = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');

const FIELD: Record<string, SnmpValue> = {
  [SYNOLOGY_UPS_OID.deviceModel]: 'VP700ELCD',
  [SYNOLOGY_UPS_OID.deviceManufacturer]: 'CPS',
  // Le numéro de série est **vide** sur ce modèle : une chaîne vide n'est pas un numéro.
  [SYNOLOGY_UPS_OID.deviceSerial]: '',
  [SYNOLOGY_UPS_OID.infoStatus]: 'OL',
  [SYNOLOGY_UPS_OID.infoLoadValue]: bytes('9F 78 04 41 30 00 00'),
  [SYNOLOGY_UPS_OID.batteryChargeValue]: bytes('9F 78 04 42 C8 00 00'),
  [SYNOLOGY_UPS_OID.batteryChargeLow]: bytes('9F 78 04 41 20 00 00'),
  [SYNOLOGY_UPS_OID.batteryVoltageValue]: bytes('9F 78 04 41 5C CC CD'),
  [SYNOLOGY_UPS_OID.batteryVoltageNominal]: bytes('9F 78 04 41 40 00 00'),
  [SYNOLOGY_UPS_OID.batteryRuntimeValue]: 3306,
  [SYNOLOGY_UPS_OID.batteryRuntimeLow]: 300,
  [SYNOLOGY_UPS_OID.inputVoltageValue]: bytes('9F 78 04 43 67 00 00'),
  [SYNOLOGY_UPS_OID.inputVoltageNominal]: bytes('9F 78 04 43 66 00 00'),
  [SYNOLOGY_UPS_OID.outputVoltageValue]: bytes('9F 78 04 43 68 00 00'),
  // Ce que cet appareil ne publie **pas**, et qui doit rester inconnu : les températures,
  // la puissance réelle mesurée (seul son nominal répond), le motif de bascule.
};

function fieldSource() {
  return {
    async get(oids: string[]): Promise<Map<string, SnmpValue>> {
      const out = new Map<string, SnmpValue>();
      for (const oid of oids) {
        if (Object.prototype.hasOwnProperty.call(FIELD, oid)) out.set(oid, FIELD[oid]!);
      }
      return out;
    },
  };
}

test('🔴 les tensions secteur et de sortie sont lues sur un vrai onduleur', async () => {
  const detail = await new SynologyUpsReader(fieldSource()).readDetail();

  assert.equal(detail.inputVoltage, 231, 'tension secteur');
  assert.equal(detail.outputVoltage, 232, 'tension de sortie');
  assert.equal(detail.inputVoltageNominal, 230, 'tension nominale du secteur');

  // ⚠️ La tension batterie est en **continu** et vaut 13,8 V. La confondre avec les deux
  // précédentes afficherait 13,8 V comme tension secteur — le genre de mensonge qui a
  // l'air d'une mesure.
  assert.ok(Math.abs((detail.batteryVoltage ?? 0) - 13.8) < 0.01, 'tension batterie (DC)');
});

test('🔴 la charge batterie est bien publiée par ce modèle', async () => {
  const live = await new SynologyUpsReader(fieldSource()).readLive();

  // Sa capture d'écran ne montrait aucune tuile de charge, d'où la conclusion — fausse —
  // que l'appareil ne la publiait pas. Elle répond, à 100 % : Homey rend `measure_battery`
  // en jauge et non en tuile de capteur.
  assert.equal(live.batteryCharge, 100);
  assert.equal(live.load, 11);
  assert.equal(live.runtimeMinutes, 55.1, '3306 s, normalisées en minutes');
  assert.equal(live.status, 'normal', '« OL » seul : sur secteur, rien à signaler');
});

test('🔴 ce que cet onduleur ne publie pas reste inconnu', async () => {
  const reader = readerForSource('synology');
  assert.ok(reader, 'le lecteur Synology doit être enregistré');
  const snapshot = await reader.readDetail(fieldSource());

  // 🔴 Les tensions doivent traverser **l'adaptateur** vers le contrat commun, et pas
  // seulement le lecteur Synology. C'est précisément là que vivait le défaut : le lecteur
  // savait les lire, l'adaptateur renvoyait `null` en dur, et aucun test ne regardait
  // cette couture. C'est la capability qui consomme ce contrat-ci, pas l'autre.
  assert.equal(snapshot.inputVoltage, 231, 'la tension secteur atteint le contrat commun');
  assert.equal(snapshot.outputVoltage, 232, 'la tension de sortie atteint le contrat commun');

  // Aucune température, sous aucun des deux OID. Un zéro ici serait lu comme « 0 °C ».
  assert.equal(snapshot.batteryTemperature, null);
  // `upsInfoRealPowerValue` est absent — seul son nominal (390 W) répond. Multiplier la
  // charge par ce nominal donnerait 43 W, un nombre plausible et inventé.
  assert.equal(snapshot.outputPower, null);
});

test('🔴 un numéro de série vide n’est pas un numéro de série', async () => {
  const identity = await new SynologyUpsReader(fieldSource()).readIdentity();
  assert.equal(identity.model, 'VP700ELCD');
  assert.equal(identity.manufacturer, 'CPS');
  assert.equal(identity.serial, null);
});
