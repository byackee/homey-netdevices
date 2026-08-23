/**
 * Lecture d'un hôte qui parle HOST-RESOURCES-MIB.
 *
 * Ce fichier est le seul à connaître à la fois les OID de `1.3.6.1.2.1.25` et le
 * domaine ; au-dessus, on manipule un {@link NasSnapshot} et rien d'autre. C'est le même
 * découpage que `lib/ups/rfc1628-reader.mts`, pour la même raison : ce qui n'est pas
 * importable dans un test n'est vérifiable que sur du vrai matériel.
 *
 * 🔴 Les quatre pièges de cette MIB, tous traités ici et nulle part ailleurs :
 * - **`hrStorageTable` mélange tout** : mémoire, swap, cache, volumes réels et systèmes
 *   de fichiers virtuels. {@link buildVolumes} trie, et dit ce qu'il a écarté ;
 * - **les tailles sont en unités d'allocation** et débordent 32 bits une fois converties :
 *   le pourcentage se calcule sur les unités brutes, les octets en flottant ;
 * - **`hrProcessorLoad` est une table** : {@link averageLoad} moyenne les cœurs ;
 * - **`hrSystemUptime` est en centièmes de seconde** et se rend en jours.
 *
 * Les erreurs de transport ne sont **pas avalées** : une injoignabilité doit remonter au
 * device, qui seul sait combien d'échecs consécutifs valent « indisponible ». Ce qui
 * *est* avalé, ce sont les groupes optionnels — capteurs de température, table des
 * processeurs — dont l'absence est une information, pas une panne.
 */

import { toNumber } from '../snmp/opaque.mjs';
import {
  HOST_OID,
  HR_PROCESSOR_LOAD,
  HR_STORAGE_COLUMN,
  HR_STORAGE_TABLE,
  HR_STORAGE_TYPE as HR_STORAGE_TYPES,
  FILESYSTEM_TYPES,
  hostColumn,
  isPseudoMount,
  storageBytes,
  storageKindOf,
  storagePercent,
  ticksToDays,
} from './host-mib.mjs';
import { SENSOR_COLUMN, SENSOR_TABLE, hottestSensor, type SensorRow } from './sensor-mib.mjs';
import { columnId, columnRows, tableRows, type TableRow } from './table.mjs';
import {
  NAS_LIVE_UNKNOWN,
  type NasDetail,
  type NasIdentity,
  type NasLive,
  type NasSnapshot,
  type NasSnmpSource,
  type NasVolume,
  type SnmpValue,
  type VolumeRejection,
} from './snapshot.mjs';

/** Le groupe `system` de SNMPv2-MIB — tout agent SNMP le porte, quelle que soit sa MIB. */
const SYSTEM_OID = {
  /** sysDescr — ce que la machine dit être. */
  descr: '1.3.6.1.2.1.1.1.0',
  /** sysName — le nom que la machine se donne, donc celui que l'utilisateur reconnaît. */
  name: '1.3.6.1.2.1.1.5.0',
} as const;

/** Ce que `sysDescr` a le droit d'occuper à l'écran. Certains agents répondent un paragraphe. */
const DESCRIPTION_LIMIT = 120;

/** Un identifiant de sous-capability n'a pas à être long : le titre porte le vrai nom. */
const VOLUME_KEY_LIMIT = 32;

// Les numéros de colonne sont dérivés des OID, jamais recopiés — voir `columnId`.
const STORAGE_COL = {
  type: columnId(HR_STORAGE_COLUMN.type),
  descr: columnId(HR_STORAGE_COLUMN.descr),
  allocationUnits: columnId(HR_STORAGE_COLUMN.allocationUnits),
  size: columnId(HR_STORAGE_COLUMN.size),
  used: columnId(HR_STORAGE_COLUMN.used),
} as const;

const SENSOR_COL = {
  type: columnId(SENSOR_COLUMN.type),
  scale: columnId(SENSOR_COLUMN.scale),
  precision: columnId(SENSOR_COLUMN.precision),
  value: columnId(SENSOR_COLUMN.value),
  operStatus: columnId(SENSOR_COLUMN.operStatus),
} as const;

/** Une `DisplayString` non vide, bornée. Un nom vide n'est pas un nom. */
export function asText(value: SnmpValue | undefined, limit = DESCRIPTION_LIMIT): string | null {
  if (value === null || value === undefined) return null;
  const text = (Buffer.isBuffer(value) ? value.toString('latin1') : String(value)).trim();
  if (text === '') return null;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Un entier de cette MIB.
 *
 * Passe par `toNumber()` de `lib/snmp/opaque.mts`, qui préserve `null` de bout en bout et
 * sait décoder l'`Opaque Float` que certains agents emploient. On ne réinterprète rien
 * soi-même : une mesure absente doit rester absente, sans quoi elle devient un zéro qui
 * ressemble à une mesure.
 */
function asNumber(value: SnmpValue | undefined): number | null {
  return toNumber(value ?? null);
}

/**
 * Une mesure bornée.
 *
 * Hors bornes ⇒ `null`, **jamais** une valeur ramenée dans l'intervalle : une lecture qui
 * part en vrille doit se voir comme « inconnue », pas se déguiser en 0 %. C'est la même
 * règle que `asMeasure` côté RFC 1628, et elle vaut pour la même raison.
 */
function asBounded(value: SnmpValue | undefined, min: number, max: number): number | null {
  const n = asNumber(value);
  if (n === null || n < min || n > max) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Les règles, sans réseau
// ---------------------------------------------------------------------------

/**
 * L'identifiant de sous-capability d'un volume, dérivé de son point de montage.
 *
 * 🔴 Du **point de montage**, jamais de `hrStorageIndex` : sous Linux l'index suit
 * l'ordre de montage et change d'un redémarrage à l'autre. Une sous-capability qui
 * change de nom, c'est une courbe Insights orpheline plus une courbe vide — et
 * `removeCapability` étant hors de question, l'orpheline reste affichée pour toujours.
 *
 * Le premier mot suffit et c'est délibéré : Linux publie `/volume1`, Windows publie
 * `C:\ Label:data Serial Number 3F2A1B` — dont tout ce qui suit `C:\` change le jour où
 * quelqu'un renomme le volume.
 *
 * `taken` porte les clés déjà attribuées : deux points de montage distincts peuvent se
 * réduire à la même chaîne, et deux sous-capabilities du même nom seraient une seule
 * capability écrite deux fois.
 */
export function volumeKey(label: string, taken: ReadonlySet<string>): string {
  const first = label.trim().split(/\s+/)[0] ?? '';
  const base =
    first
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, VOLUME_KEY_LIMIT) || 'root';

  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, VOLUME_KEY_LIMIT - 3)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Ce que le tri de `hrStorageTable` a produit. */
export interface StorageScan {
  volumes: NasVolume[];
  rejected: { label: string; reason: VolumeRejection }[];
  /** L'index de la ligne « mémoire physique », pour que le relevé rapide la relise seule. */
  memoryIndex: number | null;
}

/**
 * Trie `hrStorageTable` en volumes affichables, mémoire, et rebut.
 *
 * 🔴 **Deux filtres, pas un.** Le type écarte la RAM, le swap et le cache ; la liste de
 * points de montage virtuels écarte ce que le type laisse passer, parce que selon sa
 * version `net-snmp` publie `tmpfs` — donc `/dev/shm` et `/run` — avec le type
 * `hrStorageFixedDisk`, exactement comme un vrai volume. Le brief le désigne nommément :
 * un `/dev/shm` affiché comme disque est un défaut.
 *
 * Tout ce qui est écarté est **nommé** dans `rejected`. Un filtre dont on ne peut pas
 * constater l'effet est un filtre qu'on découvre trop agressif le jour où l'utilisateur
 * demande où est passé son volume — et qu'on n'a alors aucun moyen de lui répondre.
 */
export function buildVolumes(rows: readonly TableRow[]): StorageScan {
  const volumes: NasVolume[] = [];
  const rejected: { label: string; reason: VolumeRejection }[] = [];
  const taken = new Set<string>();
  let memoryIndex: number | null = null;

  for (const row of rows) {
    const label = asText(row.cells.get(STORAGE_COL.descr), 64) ?? `#${row.index}`;
    const kind = storageKindOf(asText(row.cells.get(STORAGE_COL.type), 128));

    if (kind === 'ram' && memoryIndex === null) memoryIndex = row.index;

    if (kind === null) {
      rejected.push({ label, reason: 'unknown-type' });
      continue;
    }
    if (!FILESYSTEM_TYPES.includes(kind)) {
      rejected.push({ label, reason: 'not-a-filesystem' });
      continue;
    }
    if (isPseudoMount(label)) {
      rejected.push({ label, reason: 'pseudo-mount' });
      continue;
    }

    const size = asNumber(row.cells.get(STORAGE_COL.size));
    const used = asNumber(row.cells.get(STORAGE_COL.used));
    const units = asNumber(row.cells.get(STORAGE_COL.allocationUnits));
    const usedPercent = storagePercent(used, size);

    if (usedPercent === null) {
      // Un volume de taille nulle est le cas normal d'un lecteur optique vide ou d'un
      // montage en cours ; un compteur qui a débordé rend une taille négative. Dans les
      // deux cas on n'a pas de pourcentage, donc pas de capability — et surtout pas 0 %,
      // qui se lirait comme un disque flambant neuf.
      rejected.push({ label, reason: 'no-usable-size' });
      continue;
    }

    const key = volumeKey(label, taken);
    taken.add(key);
    volumes.push({
      key,
      label,
      usedPercent,
      sizeBytes: storageBytes(size, units),
      usedBytes: storageBytes(used, units),
    });
  }

  return { volumes, rejected, memoryIndex };
}

/**
 * La charge CPU, moyennée sur les cœurs qui ont répondu.
 *
 * 🔴 `hrProcessorLoad` n'a **pas** de scalaire : lire « la » charge revient à lire celle
 * du premier cœur, c'est-à-dire, la moitié du temps, zéro pendant qu'un autre cœur est à
 * 100 %. La moyenne est ce que l'utilisateur croit lire quand il voit « charge CPU ».
 *
 * Une table vide rend `cpuLoad: null` et `cpuCount: 0` — jamais `0 %`, qui annoncerait
 * une machine au repos alors qu'on ne sait rien d'elle.
 */
export function averageLoad(values: readonly (number | null)[]): {
  cpuLoad: number | null;
  cpuCount: number;
} {
  const usable = values.filter(
    (value): value is number => value !== null && Number.isFinite(value) && value >= 0 && value <= 100,
  );
  if (usable.length === 0) return { cpuLoad: null, cpuCount: 0 };

  const total = usable.reduce((sum, value) => sum + value, 0);
  return { cpuLoad: Math.round((total / usable.length) * 10) / 10, cpuCount: usable.length };
}

/** Convertit une ligne de `entPhySensorTable` en {@link SensorRow}. */
export function toSensorRow(row: TableRow): SensorRow {
  return {
    index: row.index,
    type: asNumber(row.cells.get(SENSOR_COL.type)),
    scale: asNumber(row.cells.get(SENSOR_COL.scale)),
    precision: asNumber(row.cells.get(SENSOR_COL.precision)),
    value: asNumber(row.cells.get(SENSOR_COL.value)),
    operStatus: asNumber(row.cells.get(SENSOR_COL.operStatus)),
  };
}

// ---------------------------------------------------------------------------
// Le réseau
// ---------------------------------------------------------------------------

/**
 * « Est-ce une machine ? », et non « parle-t-il HOST-RESOURCES-MIB ? ».
 *
 * 🔴 La distinction a été payée sur du vrai matériel. La sonde demandait d'abord un
 * `hrSystemUptime` ou une taille mémoire, en se disant qu'un agent qui répond implémente
 * la MIB. C'est vrai — et sans intérêt : **une imprimante l'implémente aussi**. L'Epson
 * du réseau de test répond `hrSystemUptime`, annonce une `hrStorageTable`, et se
 * présentait donc comme un NAS dans le pairing.
 *
 * Ce qui distingue une machine à surveiller d'un périphérique qui parle la même MIB,
 * c'est d'avoir un **processeur** ou un **disque**. L'Epson n'a ni l'un ni l'autre : pas
 * une ligne dans `hrProcessorTable`, et pour tout stockage un « Storage RAM » de 256 Kio.
 *
 * Le prix de cette rigueur est un walk de deux colonnes au lieu d'un `get` de deux
 * scalaires. Il est payé une fois, au pairing, jamais dans la boucle de relevé.
 */
export async function probeHost(client: NasSnmpSource): Promise<boolean> {
  // Un cœur suffit : un agent qui publie une charge processeur décrit une machine.
  const loads = columnRows(await client.walk(HR_PROCESSOR_LOAD), HR_PROCESSOR_LOAD);
  if (loads.some((row) => asNumber(row.value) !== null)) return true;

  // Sinon, un vrai disque. La RAM et la mémoire virtuelle ne comptent pas — c'est
  // précisément ce que l'imprimante annonçait. Une taille nulle ne compte pas non plus :
  // un lecteur de carte vide n'est pas un disque.
  return hasRealDisk(tableRows(await client.walk(HR_STORAGE_TABLE), HR_STORAGE_TABLE));
}

/** Les types de `hrStorageTable` qui décrivent un support de masse, et eux seuls. */
const REAL_DISK: readonly string[] = [
  HR_STORAGE_TYPES.fixedDisk,
  HR_STORAGE_TYPES.removableDisk,
  HR_STORAGE_TYPES.networkDisk,
];

/**
 * Cet inventaire de stockage contient-il un disque, et pas seulement de la mémoire ?
 *
 * Exporté pour être testable seul : c'est la ligne exacte qui sépare un NAS d'une
 * imprimante, et elle mérite un test qui la vise sans passer par le réseau.
 */
export function hasRealDisk(rows: readonly TableRow[]): boolean {
  return rows.some((row) => {
    const kind = asText(row.cells.get(STORAGE_COL.type) ?? null);
    if (kind === null || !REAL_DISK.includes(kind)) return false;
    const size = asNumber(row.cells.get(STORAGE_COL.size) ?? null);
    return size !== null && size > 0;
  });
}

/** Ce que la machine dit d'elle-même. */
export async function readIdentity(client: NasSnmpSource): Promise<NasIdentity> {
  const values = await client.get([SYSTEM_OID.name, SYSTEM_OID.descr]);
  return {
    name: asText(values.get(SYSTEM_OID.name), 64),
    description: asText(values.get(SYSTEM_OID.descr)),
  };
}

/**
 * Le groupe rapide (~60 s) : uptime, charge CPU, mémoire.
 *
 * `memoryIndex` vient du relevé lent : la ligne « mémoire physique » est relue **seule**,
 * par un `get` de deux cellules, plutôt qu'en reparcourant `hrStorageTable`. Un hôte avec
 * vingt points de montage, c'est cent vingt varbinds par minute pour deux valeurs utiles —
 * sur la machine même dont on prétend mesurer la charge.
 *
 * 🔴 Le `get` passe **avant** le parcours des processeurs, et c'est l'ordre qui porte la
 * distinction : si le `get` lève, l'hôte est injoignable et l'erreur remonte. Si seul le
 * parcours échoue, l'hôte répond mais ne publie pas `hrProcessorTable` — un ESXi, un
 * agent partiel — et la charge vaut `null` sans que l'uptime soit perdu.
 */
export async function readLive(client: NasSnmpSource, memoryIndex: number | null): Promise<NasLive> {
  const memoryOids =
    memoryIndex === null
      ? []
      : [
        hostColumn(HR_STORAGE_COLUMN.size, memoryIndex),
        hostColumn(HR_STORAGE_COLUMN.used, memoryIndex),
      ];

  const values = await client.get([HOST_OID.systemUptime, ...memoryOids]);

  let cpu = { cpuLoad: NAS_LIVE_UNKNOWN.cpuLoad, cpuCount: NAS_LIVE_UNKNOWN.cpuCount };
  try {
    const loads = columnRows(await client.walk(HR_PROCESSOR_LOAD), HR_PROCESSOR_LOAD);
    cpu = averageLoad(loads.map((entry) => asNumber(entry.value)));
  } catch {
    // L'hôte a répondu au `get` : il est là. Ce groupe-ci est optionnel, et son absence
    // ne doit pas coûter l'uptime ni la mémoire.
  }

  return {
    uptimeDays: ticksToDays(asNumber(values.get(HOST_OID.systemUptime))),
    ...cpu,
    // 🔴 Le pourcentage se calcule sur les **unités d'allocation brutes**, jamais sur des
    // octets : le rapport est le même et l'opération ne peut alors pas déborder.
    memoryUsedPercent:
      memoryIndex === null
        ? null
        : storagePercent(
          asNumber(values.get(hostColumn(HR_STORAGE_COLUMN.used, memoryIndex))),
          asNumber(values.get(hostColumn(HR_STORAGE_COLUMN.size, memoryIndex))),
        ),
  };
}

/**
 * Le groupe lent (~15 min) : la carte des volumes, et la température.
 *
 * Lent parce que ce qu'il lit ne bouge pas — un volume ne change pas de taille, un NAS ne
 * gagne pas un disque en cours de journée — et parce que c'est le relevé coûteux : deux
 * parcours de table là où le rapide n'émet qu'un `get`.
 *
 * Le parcours des capteurs est optionnel et son échec est absorbé : HOST-RESOURCES ne
 * publie aucune température, ENTITY-SENSOR-MIB est une MIB séparée que la plupart des
 * Linux n'implémentent pas, et son absence est le cas normal — pas une panne.
 */
export async function readDetail(client: NasSnmpSource): Promise<NasDetail> {
  const scan = buildVolumes(tableRows(await client.walk(HR_STORAGE_TABLE), HR_STORAGE_TABLE));

  let temperature: number | null = null;
  try {
    const rows = tableRows(await client.walk(SENSOR_TABLE), SENSOR_TABLE);
    temperature = hottestSensor(rows.map(toSensorRow));
  } catch {
    // Pas de capteurs, ou une MIB absente : la capability ne sera pas déclarée, ce qui
    // est exactement ce qu'on veut dire.
  }

  return { ...scan, temperature };
}

/**
 * Un cycle complet.
 *
 * 🔴 Le relevé lent passe **avant** le rapide, et l'ordre est une contrainte, pas une
 * préférence : c'est lui qui découvre `memoryIndex`, sans lequel le relevé rapide ne sait
 * pas quelle ligne de `hrStorageTable` porte la mémoire.
 *
 * Réservé au pairing et au rythme lent. Le device n'appelle **pas** ça toutes les
 * minutes : il appelle `readLive()`. C'est ici que se décide ce que l'appareil portera
 * pour la vie — un cycle partiel écarterait des mesures que l'hôte sait pourtant donner,
 * et `removeCapability` étant hors de question, elles ne reviendraient jamais.
 */
export async function readNasSnapshot(client: NasSnmpSource): Promise<NasSnapshot> {
  const [identity, detail] = await Promise.all([readIdentity(client), readDetail(client)]);
  const live = await readLive(client, detail.memoryIndex);
  return { ...identity, ...detail, ...live };
}
