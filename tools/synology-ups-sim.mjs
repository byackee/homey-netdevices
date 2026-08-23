#!/usr/bin/env node
/**
 * Un faux NAS Synology qui relaie un onduleur, en SNMP, sur le vrai réseau.
 *
 * Pourquoi : sans onduleur joignable en SNMP, tout ce que l'app sait faire n'est validé
 * que contre des fixtures écrites à la main depuis la MIB. Cohérent, mais circulaire.
 * Ce simulateur casse le cercle sur tout ce qui n'est pas la MIB elle-même : encodage sur
 * le fil, transport UDP, sessions, rythmes de poll, transitions d'état.
 *
 * Ce qu'il prouve :   BER/Opaque, dgram, sessions, polling, enchaînement des états.
 * Ce qu'il ne prouve PAS : que les OID de la MIB Synology sont les bons. Il les tient du
 * même fichier que l'app — si l'app se trompe d'OID, le simulateur se trompe pareil.
 * Seul un vrai NAS tranchera ça.
 *
 *   node tools/synology-ups-sim.mjs                       # port 1161, onduleur sain
 *   node tools/synology-ups-sim.mjs --scenario outage     # coupure scriptée
 *   node tools/synology-ups-sim.mjs --port 1161 --community public
 *
 * Le port 161 exige les privilèges root ; 1161 par défaut, et l'app se règle dessus.
 */

import * as snmp from 'net-snmp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let SYNOLOGY_UPS_OID;
try {
  ({ SYNOLOGY_UPS_OID } = await import('../.testbuild/lib/ups/synology-mib.mjs'));
} catch {
  console.error(
    "Le simulateur lit les OID depuis le code de l'app, pour ne pas en diverger.\n" +
    'Compilez d\'abord :  npx tsc -p tsconfig.test.json',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Encodage Opaque Float, tel que Net-SNMP le pose sur le fil.
// C'est le point qui piège les bibliothèques trop strictes, donc le simulateur
// doit le produire pour de vrai, pas approximer avec un entier.
// ---------------------------------------------------------------------------
function opaqueFloat(value) {
  const buffer = Buffer.alloc(7);
  buffer[0] = 0x9f;
  buffer[1] = 0x78;
  buffer[2] = 0x04;
  buffer.writeFloatBE(value, 3);
  return buffer;
}

// ---------------------------------------------------------------------------
// Scénarios. Chacun rend l'état de l'onduleur à un instant donné.
// ---------------------------------------------------------------------------
const SCENARIOS = {
  /** Secteur présent, batterie pleine. Le cas de tous les jours. */
  normal: () => ({ status: 'OL', charge: 100, runtimeSec: 3600, load: 18 }),

  /** Secteur présent, batterie en charge après une coupure. */
  charging: () => ({ status: 'OL CHRG', charge: 62, runtimeSec: 1200, load: 21 }),

  /**
   * Une vraie coupure, scriptée : secteur, puis batterie qui se vide, puis
   * batterie faible. C'est ce qui exerce les déclencheurs de Flow.
   * 20 s sur secteur, puis décharge, `LB` sous 30 %.
   */
  outage: (elapsedSec) => {
    if (elapsedSec < 20) return { status: 'OL', charge: 100, runtimeSec: 3600, load: 18 };
    const draining = elapsedSec - 20;
    const charge = Math.max(0, 100 - draining * 2);
    const runtimeSec = Math.max(0, Math.round(3600 * (charge / 100)));
    const low = charge < 30 ? ' LB' : '';
    return { status: `OB DISCHRG${low}`, charge, runtimeSec, load: 24 };
  },

  /**
   * L'onduleur répond mais ne publie aucune mesure : tout est absent.
   * Sert à vérifier que l'app affiche « inconnu » et **jamais 0 %** — le zéro
   * silencieux étant ce qui déclencherait une fausse alerte de coupure.
   */
  silent: () => ({ status: 'OL', charge: null, runtimeSec: null, load: null }),
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(arg('port', 1161));
const community = arg('community', 'public');
const scenarioName = arg('scenario', 'normal');
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`Scénario inconnu : ${scenarioName}. Connus : ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Le MIB servi
// ---------------------------------------------------------------------------
const O = SYNOLOGY_UPS_OID;
/** Un scalaire se déclare sans son `.0` final : l'agent ajoute l'instance. */
const base = (oid) => oid.replace(/\.0$/, '');

const SCALARS = [
  ['deviceModel', O.deviceModel, snmp.ObjectType.OctetString],
  ['deviceManufacturer', O.deviceManufacturer, snmp.ObjectType.OctetString],
  ['deviceSerial', O.deviceSerial, snmp.ObjectType.OctetString],
  ['infoStatus', O.infoStatus, snmp.ObjectType.OctetString],
  ['infoLoadValue', O.infoLoadValue, snmp.ObjectType.Opaque],
  ['batteryChargeValue', O.batteryChargeValue, snmp.ObjectType.Opaque],
  ['batteryChargeLow', O.batteryChargeLow, snmp.ObjectType.Opaque],
  ['batteryVoltageValue', O.batteryVoltageValue, snmp.ObjectType.Opaque],
  ['batteryRuntimeValue', O.batteryRuntimeValue, snmp.ObjectType.Integer],
  ['batteryRuntimeLow', O.batteryRuntimeLow, snmp.ObjectType.Integer],
  // sysDescr / sysName, pour que la sonde de classification ait de quoi mordre.
  ['sysDescr', '1.3.6.1.2.1.1.1.0', snmp.ObjectType.OctetString],
  ['sysName', '1.3.6.1.2.1.1.5.0', snmp.ObjectType.OctetString],
];

const agent = snmp.createAgent({ port, disableAuthorization: false }, () => {});
const authorizer = agent.getAuthorizer();
authorizer.addCommunity(community);

const mib = agent.getMib();
for (const [name, oid, scalarType] of SCALARS) {
  if (!oid) { console.error(`OID manquant pour ${name} — la MIB de l'app a changé.`); process.exit(1); }
  mib.registerProvider({
    name,
    type: snmp.MibProviderType.Scalar,
    oid: base(oid),
    scalarType,
    // Sans `maxAccess`, un provider vaut `not-accessible` par défaut et l'agent
    // répond NoAccess sur chaque OID — en ayant pourtant l'air de fonctionner.
    maxAccess: snmp.MaxAccess['read-only'],
  });
}

const started = Date.now();
let lastStatus = null;

function refresh() {
  const elapsedSec = Math.floor((Date.now() - started) / 1000);
  const s = scenario(elapsedSec);

  mib.setScalarValue('sysDescr', 'Linux SynologySim 4.4.302+ #simulateur');
  mib.setScalarValue('sysName', 'SynologySim');
  mib.setScalarValue('deviceModel', 'Back-UPS ES 700G');
  mib.setScalarValue('deviceManufacturer', 'American Power Conversion');
  mib.setScalarValue('deviceSerial', 'SIM0000000001');
  mib.setScalarValue('infoStatus', s.status);

  // Une mesure absente n'est pas zéro : on ne publie rien du tout.
  // C'est exactement ce que fait un onduleur d'entrée de gamme sur les OID
  // qu'il n'implémente pas, et c'est ce que le scénario `silent` exerce.
  if (s.charge !== null) mib.setScalarValue('batteryChargeValue', opaqueFloat(s.charge));
  if (s.load !== null) mib.setScalarValue('infoLoadValue', opaqueFloat(s.load));
  if (s.runtimeSec !== null) mib.setScalarValue('batteryRuntimeValue', s.runtimeSec);
  mib.setScalarValue('batteryChargeLow', opaqueFloat(30));
  mib.setScalarValue('batteryVoltageValue', opaqueFloat(13.4));
  mib.setScalarValue('batteryRuntimeLow', 300);

  if (s.status !== lastStatus) {
    const min = s.runtimeSec === null ? '?' : (s.runtimeSec / 60).toFixed(1);
    console.log(`[${String(elapsedSec).padStart(4)}s] ${s.status.padEnd(16)} charge=${s.charge ?? '—'}%  autonomie=${min} min`);
    lastStatus = s.status;
  }
}

refresh();
setInterval(refresh, 1000).unref?.();
setInterval(() => {}, 1 << 30);

console.log(`Faux onduleur Synology sur udp/${port}, community « ${community} », scénario « ${scenarioName} ».`);
console.log(`Essai :  snmpget -v2c -c ${community} 127.0.0.1:${port} ${O.batteryChargeValue}`);
console.log('Ctrl+C pour arrêter.\n');
