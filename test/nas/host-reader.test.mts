import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  HOST_OID,
  HR_PROCESSOR_LOAD,
  HR_STORAGE_COLUMN,
  HR_STORAGE_TABLE,
  HR_STORAGE_TYPE,
  hostColumn,
} from '../../lib/nas/host-mib.mjs';
import {
  averageLoad,
  buildVolumes,
  probeHost,
  readDetail,
  readLive,
  readNasSnapshot,
  volumeKey,
} from '../../lib/nas/host-reader.mjs';
import { SENSOR_COLUMN, SENSOR_TABLE } from '../../lib/nas/sensor-mib.mjs';
import { tableRows } from '../../lib/nas/table.mjs';
import type { SnmpValue } from '../../lib/nas/snapshot.mjs';
import { fakeHost, unreachableHost } from './fake-host.mjs';

const T = HR_STORAGE_TABLE;
const S = SENSOR_TABLE;

/**
 * Un Synology plausible, avec **des valeurs deux à deux distinctes**.
 *
 * 🔴 C'est le garde-fou du §8.5 appliqué à la fixture elle-même. Si tous les volumes
 * étaient à 50 %, une ligne lue à la place d'une autre passerait inaperçue ; si mémoire
 * et volume système partageaient un chiffre, une colonne confondue avec sa voisine
 * aussi. Ici 85 %, 50 %, 70 %, 10 % et 28,5 % ne se ressemblent pas.
 *
 * La table est **volontairement à index épars** (1, 3, 6, 7, 31, 35, 36, 40), comme sous
 * Linux, et **volontairement encombrée** : mémoire, swap, tampons, tmpfs et lecteur vide
 * y côtoient les trois vrais volumes.
 */
const SYNOLOGY: Record<string, SnmpValue> = {
  '1.3.6.1.2.1.1.1.0': 'Linux DiskStation 4.4.302+ #69057 SMP x86_64',
  '1.3.6.1.2.1.1.5.0': 'DiskStation',

  [HOST_OID.systemUptime]: 12_960_000, // 1,5 jour
  [HOST_OID.memorySize]: 4_000_000,

  // 1 — mémoire physique : 85 %. Repérée pour le relevé rapide, jamais offerte en volume.
  [`${T}.2.1`]: HR_STORAGE_TYPE.ram,
  [`${T}.3.1`]: 'Physical memory',
  [`${T}.4.1`]: 1024,
  [`${T}.5.1`]: 4_000_000,
  [`${T}.6.1`]: 3_400_000,

  // 3 — swap.
  [`${T}.2.3`]: HR_STORAGE_TYPE.virtualMemory,
  [`${T}.3.3`]: 'Virtual memory',
  [`${T}.4.3`]: 1024,
  [`${T}.5.3`]: 2_000_000,
  [`${T}.6.3`]: 40_000,

  // 6 — les tampons, que net-snmp publie en `other`.
  [`${T}.2.6`]: HR_STORAGE_TYPE.other,
  [`${T}.3.6`]: 'Memory buffers',
  [`${T}.4.6`]: 1024,
  [`${T}.5.6`]: 4_000_000,
  [`${T}.6.6`]: 900_000,

  // 7 — le volume système : 50 %.
  [`${T}.2.7`]: HR_STORAGE_TYPE.fixedDisk,
  [`${T}.3.7`]: '/',
  [`${T}.4.7`]: 4096,
  [`${T}.5.7`]: 6_000_000,
  [`${T}.6.7`]: 3_000_000,

  // 31 — 16 To de données à 70 %. 🔴 Le produit taille × bloc déborde 32 bits.
  [`${T}.2.31`]: HR_STORAGE_TYPE.fixedDisk,
  [`${T}.3.31`]: '/volume1',
  [`${T}.4.31`]: 4096,
  [`${T}.5.31`]: 4_294_967_296,
  [`${T}.6.31`]: 3_006_477_107,

  // 35 — 🔴 tmpfs publié avec le type d'un vrai disque, comme le fait net-snmp.
  [`${T}.2.35`]: HR_STORAGE_TYPE.fixedDisk,
  [`${T}.3.35`]: '/dev/shm',
  [`${T}.4.35`]: 4096,
  [`${T}.5.35`]: 500_000,
  [`${T}.6.35`]: 250_000,

  // 36 — un partage réseau monté : 10 %.
  [`${T}.2.36`]: HR_STORAGE_TYPE.networkDisk,
  [`${T}.3.36`]: '/mnt/backup',
  [`${T}.4.36`]: 4096,
  [`${T}.5.36`]: 1_000_000,
  [`${T}.6.36`]: 100_000,

  // 40 — un lecteur optique vide : taille nulle, donc aucun pourcentage.
  [`${T}.2.40`]: HR_STORAGE_TYPE.fixedDisk,
  [`${T}.3.40`]: '/media/cdrom',
  [`${T}.4.40`]: 2048,
  [`${T}.5.40`]: 0,
  [`${T}.6.40`]: 0,

  // Quatre cœurs, très inégalement chargés : moyenne 28,5 %.
  [`${HR_PROCESSOR_LOAD}.1`]: 7,
  [`${HR_PROCESSOR_LOAD}.2`]: 91,
  [`${HR_PROCESSOR_LOAD}.3`]: 4,
  [`${HR_PROCESSOR_LOAD}.4`]: 12,

  // Quatre capteurs, dont deux seulement sont des températures lisibles. Le plus chaud
  // est à 55 °C — un disque, pas le processeur.
  [`${S}.1.1`]: 8, [`${S}.2.1`]: 9, [`${S}.3.1`]: 1, [`${S}.4.1`]: 415, [`${S}.5.1`]: 1,
  [`${S}.1.2`]: 10, [`${S}.4.2`]: 1200, [`${S}.5.2`]: 1,
  [`${S}.1.3`]: 8, [`${S}.2.3`]: 9, [`${S}.3.3`]: 0, [`${S}.4.3`]: 55, [`${S}.5.3`]: 1,
  [`${S}.1.4`]: 8, [`${S}.2.4`]: 9, [`${S}.3.4`]: 0, [`${S}.4.4`]: 99, [`${S}.5.4`]: 2,
};

const STORAGE_ROWS = tableRows(new Map(Object.entries(SYNOLOGY)), T);

// ---------------------------------------------------------------------------
// Le tri de hrStorageTable
// ---------------------------------------------------------------------------

test('🔴 buildVolumes ne retient que les vrais systèmes de fichiers', () => {
  const scan = buildVolumes(STORAGE_ROWS);
  assert.deepEqual(scan.volumes.map((volume) => volume.label), ['/', '/volume1', '/mnt/backup']);
});

test('🔴 /dev/shm n\'est pas un disque, même quand l\'agent lui donne le type d\'un disque', () => {
  // Le brief le désigne nommément. Le filtre par type ne suffit pas : net-snmp publie
  // tmpfs avec `hrStorageFixedDisk`, exactement comme /volume1.
  const scan = buildVolumes(STORAGE_ROWS);
  assert.ok(!scan.volumes.some((volume) => volume.label === '/dev/shm'));
  assert.deepEqual(
    scan.rejected.find((entry) => entry.label === '/dev/shm'),
    { label: '/dev/shm', reason: 'pseudo-mount' },
  );
});

test('la mémoire, le swap et les tampons sont écartés, et on dit pourquoi', () => {
  // Un filtre dont on ne peut pas constater l'effet est un filtre qu'on découvre trop
  // agressif le jour où l'utilisateur demande où est passé son volume.
  const scan = buildVolumes(STORAGE_ROWS);
  const reasons = new Map(scan.rejected.map((entry) => [entry.label, entry.reason]));
  assert.equal(reasons.get('Physical memory'), 'not-a-filesystem');
  assert.equal(reasons.get('Virtual memory'), 'not-a-filesystem');
  assert.equal(reasons.get('Memory buffers'), 'not-a-filesystem');
  assert.equal(reasons.get('/media/cdrom'), 'no-usable-size');
});

test('🔴 un lecteur vide n\'est pas un disque à 0 % : il n\'est pas déclaré du tout', () => {
  const scan = buildVolumes(STORAGE_ROWS);
  assert.ok(!scan.volumes.some((volume) => volume.label === '/media/cdrom'));
});

test('buildVolumes calcule des pourcentages distincts et justes', () => {
  const scan = buildVolumes(STORAGE_ROWS);
  const used = new Map(scan.volumes.map((volume) => [volume.label, volume.usedPercent]));
  assert.equal(used.get('/'), 50);
  assert.equal(used.get('/volume1'), 70);
  assert.equal(used.get('/mnt/backup'), 10);
  assert.equal(new Set(used.values()).size, 3, 'des valeurs qui convergent ne prouveraient rien');
});

test('🔴 les octets d\'un volume de 16 To ne sont pas tronqués à 32 bits', () => {
  const scan = buildVolumes(STORAGE_ROWS);
  const volume = scan.volumes.find((entry) => entry.label === '/volume1');
  assert.equal(volume?.sizeBytes, 17_592_186_044_416);
  assert.equal(volume?.usedBytes, 12_314_530_230_272);
  assert.ok((volume?.sizeBytes ?? 0) > 2 ** 32);
});

test('la ligne de mémoire physique est repérée, pour que le relevé rapide la relise seule', () => {
  assert.equal(buildVolumes(STORAGE_ROWS).memoryIndex, 1);
});

test('un type absent ou hors MIB est écarté comme « inconnu », pas offert au hasard', () => {
  const rows = tableRows(new Map<string, SnmpValue>([
    [`${T}.3.2`, '/mystere'],
    [`${T}.5.2`, 1000],
    [`${T}.6.2`, 500],
  ]), T);
  const scan = buildVolumes(rows);
  assert.deepEqual(scan.volumes, []);
  assert.deepEqual(scan.rejected, [{ label: '/mystere', reason: 'unknown-type' }]);
});

// ---------------------------------------------------------------------------
// Les clés de sous-capability
// ---------------------------------------------------------------------------

test('🔴 la clé d\'un volume vient du point de montage, jamais de l\'index', () => {
  // Sous Linux, `hrStorageIndex` change d'un redémarrage à l'autre. Une sous-capability
  // qui change de nom, c'est une courbe Insights orpheline plus une courbe vide — et
  // `removeCapability` étant hors de question, l'orpheline reste affichée pour toujours.
  const scan = buildVolumes(STORAGE_ROWS);
  assert.deepEqual(scan.volumes.map((volume) => volume.key), ['root', 'volume1', 'mnt_backup']);
});

test('volumeKey réduit les formes Linux et Windows à quelque chose de stable', () => {
  const none = new Set<string>();
  assert.equal(volumeKey('/', none), 'root');
  assert.equal(volumeKey('/volume1', none), 'volume1');
  assert.equal(volumeKey('/mnt/backup', none), 'mnt_backup');
  // Tout ce qui suit « C:\ » — l'étiquette, le numéro de série — change le jour où
  // quelqu'un renomme le volume. Seul le premier mot est stable.
  assert.equal(volumeKey('C:\\ Label:data  Serial Number 3F2A1B', none), 'c');
});

test('🔴 deux points de montage qui se réduisent pareil reçoivent des clés distinctes', () => {
  // Sans quoi ce serait une seule sous-capability écrite deux fois, donc un volume qui
  // écrase l'autre à chaque relevé.
  const taken = new Set<string>();
  const first = volumeKey('/volume1', taken);
  taken.add(first);
  const second = volumeKey('/volume1', taken);
  assert.notEqual(first, second);
  assert.equal(second, 'volume1_2');
});

// ---------------------------------------------------------------------------
// La charge CPU
// ---------------------------------------------------------------------------

test('🔴 averageLoad moyenne les cœurs : hrProcessorLoad est une table, pas un scalaire', () => {
  // Lire « la » charge revient à lire celle du premier cœur — ici 7 %, pendant qu'un
  // autre est à 91 %.
  const cpu = averageLoad([7, 91, 4, 12]);
  assert.equal(cpu.cpuLoad, 28.5);
  assert.equal(cpu.cpuCount, 4);
  assert.notEqual(cpu.cpuLoad, 7, 'c\'est la charge du premier cœur, pas la moyenne');
  assert.notEqual(cpu.cpuLoad, 91, 'c\'est le maximum, pas la moyenne');
});

test('🔴 une table de processeurs vide rend null, jamais 0 %', () => {
  // 0 % annoncerait une machine au repos alors qu'on ne sait rien d'elle.
  assert.deepEqual(averageLoad([]), { cpuLoad: null, cpuCount: 0 });
  assert.deepEqual(averageLoad([null, null]), { cpuLoad: null, cpuCount: 0 });
});

test('averageLoad ignore les cœurs hors bornes sans perdre les autres', () => {
  assert.deepEqual(averageLoad([50, 150, -3, 70, null]), { cpuLoad: 60, cpuCount: 2 });
});

// ---------------------------------------------------------------------------
// La sonde
// ---------------------------------------------------------------------------

test('probeHost reconnaît un hôte sur ses scalaires obligatoires', async () => {
  assert.equal(await probeHost(fakeHost(SYNOLOGY)), true);
});

test('probeHost accepte un uptime de zéro : une machine qui vient de démarrer existe', async () => {
  assert.equal(await probeHost(fakeHost({ [HOST_OID.systemUptime]: 0 })), true);
});

test('probeHost décline un agent SNMP qui ne publie pas la MIB', async () => {
  // Une imprimante, un switch, une carte d'onduleur : ils répondent en SNMP et n'ont pas
  // `hrSystemUptime`. Décliner est une information ; échouer n'en serait pas une.
  assert.equal(await probeHost(fakeHost({ '1.3.6.1.2.1.1.1.0': 'HP LaserJet' })), false);
});

test('probeHost laisse remonter l\'injoignabilité au lieu de la traduire en « non »', async () => {
  // « Ce n'est pas un hôte » et « il ne répond pas » envoient l'utilisateur à deux
  // endroits différents. Les confondre coûte cher dans les deux sens.
  await assert.rejects(() => probeHost(unreachableHost()), /injoignable/);
});

// ---------------------------------------------------------------------------
// Les deux relevés
// ---------------------------------------------------------------------------

test('readLive relit la ligne de mémoire par un get ciblé, pas par un parcours de table', async () => {
  // Un hôte avec vingt points de montage, c'est cent vingt varbinds par minute pour deux
  // valeurs utiles — sur la machine même dont on prétend mesurer la charge.
  const host = fakeHost(SYNOLOGY);
  const live = await readLive(host, 1);

  assert.equal(live.memoryUsedPercent, 85);
  assert.deepEqual(host.walked, [HR_PROCESSOR_LOAD], 'le relevé rapide a parcouru une table de trop');
  assert.deepEqual(host.asked[0], [
    HOST_OID.systemUptime,
    hostColumn(HR_STORAGE_COLUMN.size, 1),
    hostColumn(HR_STORAGE_COLUMN.used, 1),
  ]);
});

test('readLive rend l\'uptime en jours et la charge moyennée', async () => {
  const live = await readLive(fakeHost(SYNOLOGY), 1);
  assert.equal(live.uptimeDays, 1.5);
  assert.equal(live.cpuLoad, 28.5);
  assert.equal(live.cpuCount, 4);
});

test('🔴 sans ligne de mémoire connue, la mémoire est inconnue — et rien n\'est demandé pour elle', async () => {
  const host = fakeHost(SYNOLOGY);
  const live = await readLive(host, null);
  assert.equal(live.memoryUsedPercent, null, '0 % afficherait une machine sans mémoire occupée');
  assert.deepEqual(host.asked[0], [HOST_OID.systemUptime]);
  assert.equal(live.uptimeDays, 1.5, 'le reste du relevé doit tenir');
});

test('🔴 une table de processeurs refusée ne coûte pas l\'uptime', async () => {
  // Un ESXi, un agent partiel, une carte qui bride les requêtes : l'hôte répond, ce
  // groupe-là non. C'est une information, pas une panne.
  const host = fakeHost(SYNOLOGY, { walkFails: [HR_PROCESSOR_LOAD] });
  const live = await readLive(host, 1);
  assert.equal(live.cpuLoad, null);
  assert.equal(live.cpuCount, 0);
  assert.equal(live.uptimeDays, 1.5);
  assert.equal(live.memoryUsedPercent, 85);
});

test('🔴 un hôte injoignable fait échouer readLive : c\'est au device de compter les échecs', async () => {
  await assert.rejects(() => readLive(unreachableHost(), 1), /injoignable/);
});

test('readDetail rend les volumes triés et la température la plus élevée', async () => {
  const detail = await readDetail(fakeHost(SYNOLOGY));
  assert.deepEqual(detail.volumes.map((volume) => volume.key), ['root', 'volume1', 'mnt_backup']);
  assert.equal(detail.temperature, 55, 'le disque le plus chaud, pas la moyenne ni le CPU');
  assert.equal(detail.memoryIndex, 1);
});

test('🔴 l\'absence de capteurs ne coûte pas les volumes', async () => {
  // HOST-RESOURCES-MIB ne publie aucune température, et la plupart des Linux
  // n'implémentent pas ENTITY-SENSOR-MIB : c'est le cas normal, pas une panne.
  const detail = await readDetail(fakeHost(SYNOLOGY, { walkFails: [SENSOR_TABLE] }));
  assert.equal(detail.temperature, null);
  assert.equal(detail.volumes.length, 3);
});

test('🔴 readNasSnapshot lit le détail AVANT le rapide, sinon la mémoire est perdue', async () => {
  // C'est le relevé lent qui découvre `memoryIndex`. Inverser l'ordre donnerait un
  // snapshot de pairing sans mémoire, donc une capability jamais déclarée — et
  // `removeCapability` étant hors de question, jamais rattrapable non plus.
  const snapshot = await readNasSnapshot(fakeHost(SYNOLOGY));

  assert.equal(snapshot.memoryUsedPercent, 85, 'la mémoire n\'a pas survécu à l\'ordre des relevés');
  assert.equal(snapshot.memoryIndex, 1);
  assert.equal(snapshot.name, 'DiskStation');
  assert.match(String(snapshot.description), /^Linux DiskStation/);
  assert.equal(snapshot.uptimeDays, 1.5);
  assert.equal(snapshot.cpuLoad, 28.5);
  assert.equal(snapshot.temperature, 55);
  assert.equal(snapshot.volumes.length, 3);
});

test('un hôte qui ne rend rien laisse tout à null, et pas une valeur à zéro', async () => {
  const snapshot = await readNasSnapshot(fakeHost({}));
  assert.deepEqual(
    {
      uptimeDays: snapshot.uptimeDays,
      cpuLoad: snapshot.cpuLoad,
      memoryUsedPercent: snapshot.memoryUsedPercent,
      temperature: snapshot.temperature,
      volumes: snapshot.volumes,
      name: snapshot.name,
    },
    { uptimeDays: null, cpuLoad: null, memoryUsedPercent: null, temperature: null, volumes: [], name: null },
  );
});
