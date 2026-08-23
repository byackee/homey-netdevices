#!/usr/bin/env node
/**
 * Un faux NAS et un faux switch PoE, en SNMP, sur le vrai réseau.
 *
 * Pendant de `synology-ups-sim.mjs`, pour les deux autres drivers. La difference
 * tient a la forme des donnees : l'onduleur Synology est fait de scalaires, alors que
 * HOST-RESOURCES-MIB et IF-MIB sont des **tables** — une ligne par volume, par coeur,
 * par port. Les lecteurs les parcourent par `walk`, donc le simulateur doit servir de
 * vraies tables et pas une collection de scalaires deguises.
 *
 * ⚠️ Le provider d'une table pointe le noeud **entry**, pas la table : `hrStorageTable`
 * vaut `…25.2.3` mais le provider doit porter `…25.2.3.1`. Avec la table, les OID
 * servis perdent un niveau et aucun lecteur ne trouve rien — verifie en walk avant
 * d'ecrire ce fichier.
 *
 * Ce qu'il prouve :   encodage sur le fil, parcours de tables, pairing multi-appareils.
 * Ce qu'il ne prouve PAS : que les OID choisis sont ceux d'un vrai NAS ou d'un vrai
 * switch. Il les tient du meme dictionnaire que l'app.
 *
 *   node tools/host-switch-sim.mjs --profile nas    --port 1162
 *   node tools/host-switch-sim.mjs --profile switch --port 1163
 */

import * as snmp from 'net-snmp';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(arg('port', 1162));
const community = arg('community', 'public');
const profile = arg('profile', 'nas');
if (!['nas', 'switch'].includes(profile)) {
  console.error(`Profil inconnu : ${profile}. Connus : nas, switch`);
  process.exit(1);
}

const RO = snmp.MaxAccess['read-only'];
const RW = snmp.MaxAccess['read-write'];
const { Integer, OctetString, OID, Gauge, Counter, Counter64, TimeTicks } = snmp.ObjectType;

const agent = snmp.createAgent({ port }, () => {});
agent.getAuthorizer().addCommunity(community);
const mib = agent.getMib();

/** Un scalaire, sans son `.0` final — l'agent ajoute l'instance lui-meme. */
function scalar(name, oid, type, value) {
  mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid: oid.replace(/\.0$/, ''), scalarType: type, maxAccess: RO });
  mib.setScalarValue(name, value);
}

/**
 * Une table. `entryOid` est le noeud `…Entry`, pas le noeud `…Table` : le donner un
 * cran trop haut decale tous les OID servis et aucun lecteur ne retrouve ses colonnes.
 *
 * `index` par defaut sur la premiere colonne, ce qui est juste pour `hrStorageTable`,
 * `ifTable` et leurs semblables — mais seulement pour elles. Trois cas demandent mieux,
 * et chacun servait des OID que plus aucun lecteur ne reconnait :
 *
 * - **index externe** (« INDEX { hrDeviceIndex } ») : passer `index` explicitement ;
 * - **AUGMENTS** (`ifXTable` sur `ifTable`) : passer `augments`, sinon l'agent encode
 *   la colonne 1 — `ifName`, une chaine — comme index ;
 * - **index compose** (`pethPsePortTable`, indexe par {groupe, port}) : `index` doit
 *   nommer les deux colonnes, sinon deux prises differentes tombent au meme OID.
 */
function table(name, entryOid, columns, rows, { maxAccess = RO, index, augments } = {}) {
  mib.registerProvider({
    name,
    type: snmp.MibProviderType.Table,
    oid: entryOid,
    maxAccess,
    ...(augments ? { tableAugments: augments } : { tableIndex: index ?? [{ columnName: columns[0].name }] }),
    tableColumns: columns.map((c) => ({ ...c, maxAccess: c.maxAccess ?? maxAccess })),
  });
  for (const row of rows) mib.addTableRow(name, row);
}

const col = (number, name, type, maxAccess) => ({ number, name, type, maxAccess });

/**
 * Un Counter64 se pose en **Buffer de huit octets**, jamais en nombre : `writeUint64`
 * de net-snmp appelle `writeBuffer` sans rien convertir, et un entier fait lever
 * l'agent au moment de repondre — pas a l'enregistrement.
 */
function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

// ---------------------------------------------------------------------------
// Systeme — les deux profils le servent, c'est ce que toute sonde lit d'abord.
// ---------------------------------------------------------------------------
const SYS = profile === 'nas'
  ? { descr: 'Linux nas-sim 6.1.0 x86_64', name: 'NAS-SIM' }
  : { descr: 'Simulated 8-port PoE switch, IF-MIB + RFC 3621', name: 'SWITCH-SIM' };
scalar('sysDescr', '1.3.6.1.2.1.1.1.0', OctetString, SYS.descr);
scalar('sysName', '1.3.6.1.2.1.1.5.0', OctetString, SYS.name);

if (profile === 'nas') {
  // --- HOST-RESOURCES-MIB (RFC 2790) --------------------------------------
  const STORAGE_TYPE = '1.3.6.1.2.1.25.2.1';
  scalar('hrSystemUptime', '1.3.6.1.2.1.25.1.1.0', TimeTicks, 31_536_000); // ~3,65 jours
  scalar('hrMemorySize', '1.3.6.1.2.1.25.2.2.0', Integer, 16_777_216);     // Kio

  // 🔴 Un processeur, sinon la sonde refuse : une imprimante repond aussi a cette MIB,
  // et c'est la presence d'un CPU ou d'un disque qui distingue une machine.
  const CPU_LOADS = [17, 23, 11, 29];

  // `hrDeviceTable` porte l'index dont `hrProcessorEntry` depend. Un vrai hote la sert,
  // et sans elle l'index de la table processeur n'a rien sur quoi s'appuyer.
  table('hrDeviceTable', '1.3.6.1.2.1.25.3.2.1', [
    col(1, 'hrDeviceIndex', Integer),
    col(2, 'hrDeviceType', OID),
    col(3, 'hrDeviceDescr', OctetString),
  ], CPU_LOADS.map((_, i) => [i + 1, '1.3.6.1.2.1.25.3.1.3', `CPU ${i + 1}`]));

  table('hrProcessorTable', '1.3.6.1.2.1.25.3.3.1', [
    col(1, 'hrProcessorFrwID', OID),
    col(2, 'hrProcessorLoad', Integer),
  ], CPU_LOADS.map((load, i) => [i + 1, '0.0', load]),
    { index: [{ columnName: 'hrDeviceIndex', foreign: 'hrDeviceTable' }] });

  // De la RAM, de la memoire virtuelle et deux vrais volumes : le lecteur doit trier.
  table('hrStorageTable', '1.3.6.1.2.1.25.2.3.1', [
    col(1, 'hrStorageIndex', Integer),
    col(2, 'hrStorageType', OID),
    col(3, 'hrStorageDescr', OctetString),
    col(4, 'hrStorageAllocationUnits', Integer),
    col(5, 'hrStorageSize', Integer),
    col(6, 'hrStorageUsed', Integer),
  ], [
    [1, `${STORAGE_TYPE}.2`, 'Physical memory',   1024, 16_777_216,  6_800_000],
    [2, `${STORAGE_TYPE}.3`, 'Virtual memory',    1024,  4_194_304,    120_000],
    [3, `${STORAGE_TYPE}.4`, '/volume1',          4096, 976_000_000, 588_000_000],
    [4, `${STORAGE_TYPE}.4`, '/volume2',          4096, 488_000_000, 202_000_000],
    [5, `${STORAGE_TYPE}.2`, '/dev/shm',          1024,     512_000,          0],
  ]);
} else {
  // --- IF-MIB (RFC 2863) + POWER-ETHERNET-MIB (RFC 3621) ------------------
  const PORTS = 8;
  scalar('ifNumber', '1.3.6.1.2.1.2.1.0', Integer, PORTS);

  const up = (i) => (i <= 5 ? 1 : 2); // cinq ports actifs, trois libres
  table('ifTable', '1.3.6.1.2.1.2.2.1', [
    col(1, 'ifIndex', Integer),
    col(2, 'ifDescr', OctetString),
    col(3, 'ifType', Integer),
    col(5, 'ifSpeed', Gauge),
    col(7, 'ifAdminStatus', Integer, RW),
    col(8, 'ifOperStatus', Integer),
    col(14, 'ifInErrors', Counter),
    col(20, 'ifOutErrors', Counter),
  ], Array.from({ length: PORTS }, (_, k) => {
    const i = k + 1;
    return [i, `GigabitEthernet0/${i}`, 6, up(i) === 1 ? 1_000_000_000 : 0, 1, up(i), i === 3 ? 12 : 0, 0];
  }));

  // ifXTable AUGMENTS ifTable : son index est `ifIndex`, pas sa colonne 1.
  table('ifXTable', '1.3.6.1.2.1.31.1.1.1', [
    col(1, 'ifName', OctetString),
    // Les compteurs d'octets sont en Counter64 : c'est ce qui rend le debit lisible sur
    // du gigabit, ou un Counter32 boucle en une trentaine de secondes.
    col(6, 'ifHCInOctets', Counter64),
    col(10, 'ifHCOutOctets', Counter64),
    col(15, 'ifHighSpeed', Gauge),
    col(18, 'ifAlias', OctetString),
    col(19, 'ifCounterDiscontinuityTime', TimeTicks),
  ], Array.from({ length: PORTS }, (_, k) => {
    const i = k + 1;
    const alias = { 1: 'Homey', 2: 'NAS', 3: 'Camera entree', 4: 'Point d acces', 5: 'Bureau' }[i] ?? '';
    const busy = up(i) === 1;
    return [
      i, `Gi0/${i}`,
      u64(busy ? 4_000_000_000n * BigInt(i) : 0n),
      u64(busy ? 1_500_000_000n * BigInt(i) : 0n),
      busy ? 1000 : 0, alias, 0,
    ];
  }), { augments: 'ifTable' });

  // Alimentation PoE : quatre prises, index {groupe, port}.
  table('pethPsePortTable', '1.3.6.1.2.1.105.1.1.1', [
    col(1, 'pethPsePortGroupIndex', Integer),
    col(2, 'pethPsePortIndex', Integer),
    col(3, 'pethPsePortAdminEnable', Integer, RW),
    col(6, 'pethPsePortDetectionStatus', Integer),
    col(10, 'pethPsePortPowerClassifications', Integer),
  ], Array.from({ length: 4 }, (_, k) => {
    const i = k + 1;
    return [1, i, 1, i <= 3 ? 3 : 2, i <= 3 ? 4 : 1]; // trois alimentent, une cherche
  }), { index: [{ columnName: 'pethPsePortGroupIndex' }, { columnName: 'pethPsePortIndex' }] });

  // ⚠️ pethMainPseTable est sous pethObjects.3.1, pas powerEthernetMIB.3.
  table('pethMainPseTable', '1.3.6.1.2.1.105.1.3.1', [
    col(1, 'pethMainPseGroupIndex', Integer),
    col(2, 'pethMainPsePower', Gauge),
    col(3, 'pethMainPseOperStatus', Integer),
    col(4, 'pethMainPseConsumptionPower', Gauge),
    col(5, 'pethMainPseUsageThreshold', Integer, RW),
  ], [[1, 130, 1, 47, 80]]);
}

setInterval(() => {}, 1 << 30);
console.log(`Faux ${profile} sur udp/${port}, community « ${community} ».`);
console.log(`Essai :  snmpwalk -v2c -c ${community} 127.0.0.1:${port} 1.3.6.1.2.1.1`);
console.log('Ctrl+C pour arrêter.\n');
