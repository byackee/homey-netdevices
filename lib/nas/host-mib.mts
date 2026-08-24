/**
 * HOST-RESOURCES-MIB (RFC 2790) — `1.3.6.1.2.1.25`.
 *
 * C'est la MIB standard de « une machine, et ce qu'elle a dedans ». Un Synology, un
 * QNAP, un Linux avec `snmpd`, un ESXi, un Windows avec le service SNMP : tous
 * l'implémentent, et tous rendent la même chose. Un seul driver couvre donc toutes les
 * marques, ce qui est exactement l'inverse de la situation des onduleurs, où quatre
 * dialectes décrivent le même appareil.
 *
 * Quatre singularités de cette MIB méritent d'être nommées ici, parce qu'elles se
 * paient cher plus loin :
 *
 * 1. 🔴 **`hrStorageTable` n'est pas une table de disques.** Elle mélange la mémoire
 *    physique, le swap, les systèmes de fichiers réels et les systèmes de fichiers
 *    virtuels (`/dev/shm`, `/run`, `/proc`). La colonne `hrStorageType` les distingue —
 *    voir {@link HR_STORAGE_TYPE} et {@link storageKindOf}. Afficher `/dev/shm` comme
 *    « disque » est un défaut, pas une approximation : l'utilisateur croit avoir un
 *    volume à 100 % alors qu'il regarde un tmpfs qui fait son travail.
 * 2. 🔴 **`hrStorageSize` est en unités d'allocation, pas en octets**, et le produit
 *    `size × allocationUnits` **déborde un entier 32 bits** dès 4 To. Il se calcule en
 *    `number` flottant (voir {@link storageBytes}) et **jamais** avec un opérateur
 *    bit-à-bit, qui tronquerait silencieusement à 32 bits.
 * 3. 🔴 **`hrProcessorLoad` est une table, une ligne par cœur.** Un scalaire n'existe
 *    pas. Le lecteur moyenne, et le dit — voir `host-reader.mts`.
 * 4. 🔴 **`hrSystemUptime` est en centièmes de seconde** (`TimeTicks`), comme partout
 *    ailleurs en SNMP, et **déborde à 2³² centièmes, soit ~497 jours**. Un NAS qui
 *    dépasse cette durée voit son uptime repartir de zéro sans avoir redémarré.
 *
 * Les OID sont ceux de la RFC 2790, dont l'arbre `host` est stable depuis RFC 1514.
 * ⚠️ Contrairement à `lib/ups/rfc1628-mib.mts`, ils n'ont **pas** été recoupés ligne à
 * ligne au texte de la RFC dans le cadre de ce dépôt : l'annexe A ne couvre pas
 * HOST-RESOURCES. C'est pourquoi rien ici n'invente de valeur — un OID faux rend
 * `noSuchObject`, donc `null`, donc une capability non déclarée, et jamais un chiffre
 * crédible et faux.
 */

const BASE = '1.3.6.1.2.1.25';

/** Le groupe `hrSystem` `.1` et le groupe `hrStorage` `.2` — leurs scalaires. */
export const HOST_OID = {
  /**
   * hrSystemUptime — 🔴 **centièmes de seconde**, et déborde à ~497 jours.
   *
   * Distinct de `sysUpTime` (`1.3.6.1.2.1.1.3.0`), qui compte depuis le démarrage de
   * l'**agent** : redémarrer `snmpd` remet `sysUpTime` à zéro sans que la machine ait
   * bougé. On ne se rabat donc pas sur lui — ce serait annoncer un redémarrage qui n'a
   * pas eu lieu.
   */
  systemUptime: `${BASE}.1.1.0`,
  /** hrSystemDate — `DateAndTime` en octets. Non lu : l'heure de l'hôte n'apprend rien ici. */
  systemDate: `${BASE}.1.2.0`,
  /** hrSystemNumUsers — sessions ouvertes. */
  systemNumUsers: `${BASE}.1.5.0`,
  /** hrSystemProcesses — processus en cours. */
  systemProcesses: `${BASE}.1.6.0`,
  /**
   * hrMemorySize — RAM totale, en **kilo-octets**.
   *
   * Sert de sonde : c'est un scalaire obligatoire du groupe `hrStorage`, donc sa
   * présence prouve que l'hôte implémente vraiment la MIB, là où une table vide ne
   * prouve rien.
   */
  memorySize: `${BASE}.2.2.0`,
} as const;

/**
 * La racine de `hrStorageTable`.
 *
 * On la parcourt **d'un seul `walk`** plutôt que colonne par colonne : six parcours
 * séparés, c'est six fois le nombre d'allers-retours pour la même information, et rien
 * ne garantit qu'ils voient la table dans le même état.
 */
export const HR_STORAGE_TABLE = `${BASE}.2.3.1`;

/**
 * Les colonnes de `hrStorageTable` (`.2.3.1`).
 *
 * 🔴 Ce sont des **préfixes** : il leur manque l'index de ligne. Passer par
 * {@link hostColumn}, jamais par une concaténation à la main.
 *
 * ⚠️ `hrStorageIndex` **n'est pas stable d'un redémarrage à l'autre** sur Linux : il
 * suit l'ordre de montage. C'est pourquoi une sous-capability de volume est nommée
 * d'après `hrStorageDescr` — le point de montage — et jamais d'après l'index.
 */
export const HR_STORAGE_COLUMN = {
  /** hrStorageIndex. */
  index: `${BASE}.2.3.1.1`,
  /** hrStorageType — 🔴 un **OID**, pas un entier. Voir {@link storageKindOf}. */
  type: `${BASE}.2.3.1.2`,
  /** hrStorageDescr — le point de montage sous Linux, `C:\ Label:…` sous Windows. */
  descr: `${BASE}.2.3.1.3`,
  /** hrStorageAllocationUnits — taille d'un bloc, **en octets**. */
  allocationUnits: `${BASE}.2.3.1.4`,
  /** hrStorageSize — taille totale, **en unités d'allocation**. */
  size: `${BASE}.2.3.1.5`,
  /** hrStorageUsed — occupation, **en unités d'allocation**. */
  used: `${BASE}.2.3.1.6`,
  /** hrStorageAllocationFailures — Counter32. Non lu : sans delta, il n'apprend rien. */
  allocationFailures: `${BASE}.2.3.1.7`,
} as const;

/**
 * `hrProcessorLoad` (`hrDevice` `.3.3.1.2`) — charge moyenne du cœur sur la dernière
 * minute, en pourcent, `INTEGER(0..100)`.
 *
 * 🔴 **Une ligne par cœur.** Il n'existe aucun scalaire de charge CPU dans cette MIB :
 * un NAS à huit cœurs rend huit valeurs, et lire « la » charge revient à lire celle du
 * premier cœur — c'est-à-dire, la moitié du temps, zéro pendant que la machine rame.
 */
export const HR_PROCESSOR_LOAD = `${BASE}.3.3.1.2`;

/** Compose l'OID d'une cellule à partir de sa colonne et de son index de ligne. */
export function hostColumn(column: string, index: number): string {
  return `${column}.${index}`;
}

/**
 * Les valeurs de `hrStorageType`, sous `hrStorageTypes` (`1.3.6.1.2.1.25.2.1`).
 *
 * Ce sont des OID, pas des entiers : `hrStorageFixedDisk` vaut littéralement la chaîne
 * `1.3.6.1.2.1.25.2.1.4`.
 */
const STORAGE_TYPE_BASE = `${BASE}.2.1`;

export const HR_STORAGE_TYPE = {
  other: `${STORAGE_TYPE_BASE}.1`,
  ram: `${STORAGE_TYPE_BASE}.2`,
  virtualMemory: `${STORAGE_TYPE_BASE}.3`,
  fixedDisk: `${STORAGE_TYPE_BASE}.4`,
  removableDisk: `${STORAGE_TYPE_BASE}.5`,
  floppyDisk: `${STORAGE_TYPE_BASE}.6`,
  compactDisc: `${STORAGE_TYPE_BASE}.7`,
  ramDisk: `${STORAGE_TYPE_BASE}.8`,
  flashMemory: `${STORAGE_TYPE_BASE}.9`,
  networkDisk: `${STORAGE_TYPE_BASE}.10`,
} as const;

export type HrStorageType = keyof typeof HR_STORAGE_TYPE;

const TYPE_BY_OID = new Map<string, HrStorageType>(
  (Object.entries(HR_STORAGE_TYPE) as [HrStorageType, string][]).map(([name, oid]) => [oid, name]),
);

/**
 * Traduit un `hrStorageType` en nom, ou `null` pour un OID hors de la MIB.
 *
 * L'OID est normalisé de son éventuel point initial : certains agents rendent
 * `.1.3.6.1…`, d'autres `1.3.6.1…`, et les deux désignent le même objet. C'est le même
 * traitement que `decodeAlarmOid` applique côté RFC 1628, pour la même raison.
 *
 * Un type inconnu rend `null` et **n'interrompt rien** : la ligne est simplement écartée
 * du côté « je ne sais pas ce que c'est », ce qui est la vérité.
 */
export function storageKindOf(value: string | null): HrStorageType | null {
  if (value === null) return null;
  return TYPE_BY_OID.get(value.trim().replace(/^\./, '')) ?? null;
}

/**
 * Les types qui décrivent un **système de fichiers montré à l'utilisateur**.
 *
 * `fixedDisk` est le cas normal (un volume local), `networkDisk` couvre un partage
 * monté à distance. Tout le reste est délibérément dehors :
 *
 * - `ram` et `virtualMemory` sont la mémoire et le swap, qui ont leur propre capability ;
 * - `other` est ce que net-snmp emploie pour « Cached memory » et « Buffer memory » ;
 * - `removableDisk`, `floppyDisk`, `compactDisc` sont des supports amovibles dont la
 *   présence même est intermittente : déclarer une capability pour une clé USB
 *   branchée le temps d'une sauvegarde laisserait une courbe morte pour toujours,
 *   `removeCapability` étant hors de question ;
 * - `ramDisk` et `flashMemory` sont des disques virtuels ou de la mémoire interne.
 */
export const FILESYSTEM_TYPES: readonly HrStorageType[] = ['fixedDisk', 'networkDisk'];

/**
 * Les points de montage virtuels que le type ne suffit pas à écarter.
 *
 * 🔴 Le filtre par type est **nécessaire et insuffisant**. Selon la version, `net-snmp`
 * publie `tmpfs` — donc `/dev/shm`, `/run`, `/run/lock` — avec le type
 * `hrStorageFixedDisk`, exactement comme un vrai volume. Le brief le désigne
 * nommément : « un `/dev/shm` affiché comme disque est un défaut ».
 *
 * La liste vise des **préfixes de chemin**, pas des sous-chaînes : `/run` écarte
 * `/run/lock` mais pas `/runtime-data`, et `/dev` écarte `/dev/shm` sans toucher à
 * `/devices`. Ce qui n'est pas là passe : le doute profite au volume, parce qu'un
 * volume manquant est une perte de fonction, alors qu'un pseudo-volume affiché n'est
 * qu'une ligne en trop qu'on peut nommer.
 */
export const PSEUDO_MOUNTS: readonly string[] = [
  '/dev',
  '/proc',
  '/sys',
  '/run',
  /**
   * 🔴 `/tmp` est de la RAM sur la plupart des systèmes, et Synology la déclare avec un
   * type de **disque** — elle passe donc le filtre de type et n'est arrêtée que par ce
   * filtre-ci. Relevé sur un vrai DSM : l'app y offrait « /tmp » à 0,7 % et
   * « /tmp/SynologyAuthService » à 2,8 % comme s'il s'agissait de volumes de stockage.
   *
   * Le préfixe couvre les enfants : `/tmp/SynologyAuthService` tombe avec le parent.
   */
  '/tmp',
  '/tmpfs',
  '/var/lib/docker',
  '/snap',
];

/**
 * Vrai si ce point de montage est un système de fichiers virtuel.
 *
 * Comparaison sur des segments entiers : `/run` correspond à `/run` et `/run/lock`,
 * jamais à `/runtime`.
 */
export function isPseudoMount(descr: string): boolean {
  const path = descr.trim().split(/\s+/)[0] ?? '';
  if (path === '') return false;
  const lower = path.toLowerCase();
  return PSEUDO_MOUNTS.some((mount) => lower === mount || lower.startsWith(`${mount}/`));
}

/**
 * `hrStorageSize`/`hrStorageUsed` convertis en octets.
 *
 * 🔴 Multiplication en **flottant**, jamais en entier : un volume de 16 To fait
 * 1,6 × 10¹³ octets, soit près de quatre mille fois la capacité d'un entier 32 bits
 * signé. Un `|0`, un `>>> 0` ou un `Math.imul` de trop rendrait une taille plausible et
 * fausse — le pire cas décrit par le §8.5 du plan.
 *
 * `Number.MAX_SAFE_INTEGER` (~9 × 10¹⁵ octets, soit 9 pétaoctets) est la vraie limite
 * de ce calcul, et au-delà il rend `null` plutôt qu'un nombre qui a perdu ses unités.
 */
export function storageBytes(units: number | null, allocationUnits: number | null): number | null {
  if (units === null || allocationUnits === null) return null;
  if (!Number.isFinite(units) || !Number.isFinite(allocationUnits)) return null;
  if (units < 0 || allocationUnits <= 0) return null;
  const bytes = units * allocationUnits;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Le taux d'occupation d'un volume, en pourcent.
 *
 * 🔴 Calculé sur les **unités d'allocation brutes**, pas sur les octets : le rapport est
 * le même et l'opération ne peut alors pas déborder, quel que soit le volume. Convertir
 * en octets avant de diviser n'apporterait rien et exposerait le calcul au débordement
 * que {@link storageBytes} prend soin d'écarter.
 *
 * Un `size` nul ou négatif — ce que rend un agent dont le compteur a débordé — donne
 * `null`. Un `used` supérieur à `size` aussi : c'est incohérent, et une valeur ramenée
 * à 100 % se lirait comme un disque plein, c'est-à-dire une alerte inventée.
 */
export function storagePercent(used: number | null, size: number | null): number | null {
  if (used === null || size === null) return null;
  if (!Number.isFinite(used) || !Number.isFinite(size)) return null;
  if (size <= 0 || used < 0 || used > size) return null;
  return Math.round((used / size) * 1000) / 10;
}

/**
 * `hrSystemUptime` converti en **jours**.
 *
 * Le jour est délibéré. Les centièmes de seconde changeraient à chaque relevé, et une
 * capability Homey écrit un point Insights à chaque valeur *différente* : un uptime en
 * secondes écrirait toutes les soixante secondes pour toujours (plan §8.6). Arrondi au
 * dixième de jour, il n'écrit qu'une fois toutes les 2,4 heures — et « 43,6 jours » est
 * de toute façon la seule forme sous laquelle un uptime se lit.
 */
export function ticksToDays(ticks: number | null): number | null {
  if (ticks === null || !Number.isFinite(ticks) || ticks < 0) return null;
  return Math.round((ticks / 8_640_000) * 10) / 10;
}
