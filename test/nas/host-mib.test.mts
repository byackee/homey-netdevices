import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { MAX_VOLUMES, buildVolumes } from '../../lib/nas/host-reader.mjs';
import { columnId, type TableRow } from '../../lib/nas/table.mjs';
import type { SnmpValue } from '../../lib/nas/snapshot.mjs';
import {
  FILESYSTEM_TYPES,
  HR_STORAGE_COLUMN,
  HR_STORAGE_TYPE,
  isPseudoMount,
  storageBytes,
  storageKindOf,
  storagePercent,
  ticksToDays,
} from '../../lib/nas/host-mib.mjs';

test('🔴 les fixtures d\'unité distinguent bien les conversions candidates', () => {
  // Garde-fou sur les tests eux-mêmes (plan §8.5), calqué sur `test/ups/units.test.mts` :
  // avec une valeur mal choisie, « diviser par 8 640 000 » et « diviser par 86 400 »
  // donneraient le même résultat, la suite passerait au vert, et le facteur 100 partirait
  // en production.
  assert.equal(new Set([12_960_000, 12_960_000 / 86_400, 12_960_000 / 8_640_000]).size, 3);
  // Et pour les tailles : 4 096 octets par bloc, ce n'est ni 4 000 ni 1.
  assert.equal(new Set([4096, 4000, 1]).size, 3);
});

// ---------------------------------------------------------------------------

test('storageBytes multiplie en flottant : un volume de 16 To ne déborde pas', () => {
  // 🔴 Le piège nommé par le brief. 4 294 967 296 blocs de 4 096 octets font
  // 1,76 × 10¹³ octets — quatre mille fois la capacité d'un entier 32 bits signé.
  const bytes = storageBytes(4_294_967_296, 4_096);
  assert.equal(bytes, 17_592_186_044_416);
  assert.ok(bytes !== null && bytes > 2 ** 31, 'la taille a été tronquée à 32 bits');
});

test('storageBytes rend null plutôt qu\'un nombre qui a perdu ses unités', () => {
  assert.equal(storageBytes(null, 4096), null);
  assert.equal(storageBytes(1000, null), null);
  assert.equal(storageBytes(-1, 4096), null, 'un compteur qui a débordé rend une taille négative');
  assert.equal(storageBytes(1000, 0), null, 'un bloc de zéro octet n\'existe pas');
  assert.equal(storageBytes(Number.MAX_SAFE_INTEGER, 4096), null,
    'au-delà de l\'entier sûr, le produit n\'est plus le produit');
  assert.equal(storageBytes(0, 4096), 0, 'un volume vide est une mesure, pas une absence');
});

test('storagePercent se calcule sur les unités brutes, donc ne déborde jamais', () => {
  // Le même volume de 16 To, à moitié plein. Le rapport est le même en blocs et en
  // octets, mais le calcul en blocs ne peut pas sortir de l'intervalle des entiers sûrs.
  assert.equal(storagePercent(2_147_483_648, 4_294_967_296), 50);
  assert.equal(storagePercent(715, 1000), 71.5, 'arrondi au dixième');
  assert.equal(storagePercent(0, 1000), 0, 'un volume vide est une mesure');
  assert.equal(storagePercent(1000, 1000), 100);
});

test('🔴 storagePercent refuse l\'incohérent au lieu de le raboter', () => {
  // Une valeur ramenée à 100 % se lirait comme un disque plein, c'est-à-dire une alerte
  // inventée ; ramenée à 0 %, comme un disque neuf.
  assert.equal(storagePercent(1200, 1000), null, 'occupation supérieure à la taille');
  assert.equal(storagePercent(-5, 1000), null);
  assert.equal(storagePercent(500, 0), null, 'un lecteur optique vide, ou un montage en cours');
  assert.equal(storagePercent(500, -1000), null, 'compteur débordé');
  assert.equal(storagePercent(null, 1000), null);
  assert.equal(storagePercent(500, null), null);
});

test('ticksToDays divise par 8 640 000, pas par 86 400', () => {
  assert.equal(ticksToDays(8_640_000), 1, '8 640 000 centièmes de seconde font un jour');
  assert.equal(ticksToDays(12_960_000), 1.5);
  assert.notEqual(ticksToDays(12_960_000), 150, 'ce ne sont pas des secondes');
  assert.notEqual(ticksToDays(12_960_000), 12_960_000, 'ce ne sont pas déjà des jours');
  assert.equal(ticksToDays(0), 0, 'une machine qui vient de démarrer existe');
});

test('ticksToDays refuse un uptime négatif', () => {
  assert.equal(ticksToDays(-1), null);
  assert.equal(ticksToDays(null), null);
  assert.equal(ticksToDays(Number.NaN), null);
});

// ---------------------------------------------------------------------------

test('storageKindOf reconnaît les types de la MIB, point initial ou non', () => {
  assert.equal(storageKindOf(HR_STORAGE_TYPE.fixedDisk), 'fixedDisk');
  assert.equal(storageKindOf('.1.3.6.1.2.1.25.2.1.4'), 'fixedDisk',
    'certains agents rendent l\'OID avec un point initial');
  assert.equal(storageKindOf(HR_STORAGE_TYPE.ram), 'ram');
  assert.equal(storageKindOf(HR_STORAGE_TYPE.networkDisk), 'networkDisk');
});

test('storageKindOf dégrade proprement sur un type hors de la MIB', () => {
  // Un constructeur peut définir le sien sous sa MIB privée. Faire échouer la lecture
  // pour ça échangerait une ligne non classée contre une perte totale de mesure.
  assert.equal(storageKindOf('1.3.6.1.4.1.6574.99'), null);
  assert.equal(storageKindOf(null), null);
  assert.equal(storageKindOf(''), null);
});

test('🔴 la mémoire et le swap ne sont pas des systèmes de fichiers', () => {
  // Ils ont leur propre capability ; les afficher comme des volumes donnerait à
  // l'utilisateur un « disque » à 92 % qui est en fait sa RAM en bonne santé.
  assert.deepEqual([...FILESYSTEM_TYPES].sort(), ['fixedDisk', 'networkDisk']);
  for (const kind of ['ram', 'virtualMemory', 'other', 'ramDisk', 'removableDisk'] as const) {
    assert.ok(!FILESYSTEM_TYPES.includes(kind), `${kind} ne doit pas être offert comme volume`);
  }
});

// ---------------------------------------------------------------------------

test('🔴 isPseudoMount écarte ce que le type laisse passer', () => {
  // Selon sa version, net-snmp publie tmpfs avec le type `hrStorageFixedDisk`, exactement
  // comme un vrai volume. Le brief le désigne nommément : « un /dev/shm affiché comme
  // disque est un défaut ».
  assert.ok(isPseudoMount('/dev/shm'));
  assert.ok(isPseudoMount('/run'));
  assert.ok(isPseudoMount('/run/lock'));
  assert.ok(isPseudoMount('/proc'));
  assert.ok(isPseudoMount('/sys/fs/cgroup'));

  // 🔴 `/tmp` est de la RAM, et Synology le déclare avec un type de **disque** : il passe
  // donc le filtre de type et n'est arrêté que par celui-ci. Relevé sur un vrai DSM, où
  // l'app offrait « /tmp » et « /tmp/SynologyAuthService » comme s'il s'agissait de
  // volumes de stockage, à côté du seul vrai — `/volume1`.
  assert.ok(isPseudoMount('/tmp'));
  assert.ok(isPseudoMount('/tmp/SynologyAuthService'), 'le préfixe doit emporter les enfants');
});

test('🔴 isPseudoMount compare des segments, pas des sous-chaînes', () => {
  // Le doute profite au volume : un volume manquant est une perte de fonction, un
  // pseudo-volume affiché n'est qu'une ligne en trop qu'on peut nommer.
  assert.ok(!isPseudoMount('/runtime-data'), '/run ne doit pas emporter /runtime-data');
  assert.ok(!isPseudoMount('/devices'), '/dev ne doit pas emporter /devices');
  assert.ok(!isPseudoMount('/volume1'));
  assert.ok(!isPseudoMount('/'));
  assert.ok(!isPseudoMount('C:\\ Label:data  Serial Number 3F2A1B'));
  assert.ok(!isPseudoMount(''));
});

test('isPseudoMount ne regarde que le point de montage, pas l\'étiquette qui suit', () => {
  // Windows publie « C:\ Label:… Serial Number … » ; un agent Linux peut suffixer le
  // type de système de fichiers. Seul le premier mot est un chemin.
  assert.ok(isPseudoMount('/dev/shm  (tmpfs)'));
  assert.ok(!isPseudoMount('/data  /dev/sda1'), 'le second mot n\'est pas le point de montage');
});

// ---------------------------------------------------------------------------

/**
 * 🔴 Le plafond de volumes est un cliquet contre l'irréversible.
 *
 * Chaque volume devient une sous-capability, avec son journal Insights, et une capability
 * n'est **jamais** retirée — `removeCapability` détruirait cet historique. Un hôte qui
 * publierait des centaines de lignes de `hrStorageTable` ferait donc gonfler l'appareil
 * sans autre issue que de le supprimer et le réappairer.
 *
 * Il ne faut pas d'appareil compromis pour y arriver : un firmware fantaisiste suffit, et
 * l'utilisateur a déjà appairé la machine.
 */
test('🔴 le nombre de volumes est plafonné, et le surplus reste visible', () => {
  const lignes = Array.from({ length: MAX_VOLUMES + 15 }, (_, i) => ({
    index: i + 1,
    cells: new Map<number, SnmpValue>([
      [columnId(HR_STORAGE_COLUMN.type), HR_STORAGE_TYPE.fixedDisk],
      [columnId(HR_STORAGE_COLUMN.descr), `/volume${i + 1}`],
      [columnId(HR_STORAGE_COLUMN.allocationUnits), 4096],
      [columnId(HR_STORAGE_COLUMN.size), 1_000_000],
      [columnId(HR_STORAGE_COLUMN.used), 500_000],
    ]),
  }));

  const scan = buildVolumes(lignes);
  assert.equal(scan.volumes.length, MAX_VOLUMES, 'le plafond tient');
  assert.equal(
    scan.rejected.filter((r) => r.reason === 'over-limit').length,
    15,
    'le surplus part dans les rejets plutôt que de disparaître en silence',
  );
});

test('🔴 le plafond se compte après les filtres, pas avant', () => {
  // Un hôte dont les premières lignes sont des pseudo-montages ne doit pas voir ses vrais
  // volumes écartés par un compte que du bruit aurait épuisé.
  const bruit = Array.from({ length: MAX_VOLUMES }, (_, i) => ({
    index: i + 1,
    cells: new Map<number, SnmpValue>([
      [columnId(HR_STORAGE_COLUMN.type), HR_STORAGE_TYPE.fixedDisk],
      [columnId(HR_STORAGE_COLUMN.descr), `/tmp/cache${i}`],
      [columnId(HR_STORAGE_COLUMN.allocationUnits), 4096],
      [columnId(HR_STORAGE_COLUMN.size), 1_000],
      [columnId(HR_STORAGE_COLUMN.used), 500],
    ]),
  }));
  const vrai = {
    index: 999,
    cells: new Map<number, SnmpValue>([
      [columnId(HR_STORAGE_COLUMN.type), HR_STORAGE_TYPE.fixedDisk],
      [columnId(HR_STORAGE_COLUMN.descr), '/volume1'],
      [columnId(HR_STORAGE_COLUMN.allocationUnits), 4096],
      [columnId(HR_STORAGE_COLUMN.size), 1_000_000],
      [columnId(HR_STORAGE_COLUMN.used), 500_000],
    ]),
  };

  const scan = buildVolumes([...bruit, vrai]);
  assert.equal(scan.volumes.length, 1, 'le seul vrai volume passe');
  assert.equal(scan.volumes[0]?.label, '/volume1');
});
