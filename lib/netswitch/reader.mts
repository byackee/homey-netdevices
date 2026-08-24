/**
 * Ce qu'on demande à un switch, et ce qu'on en fait.
 *
 * Deux questions distinctes, à deux rythmes distincts :
 *
 * - {@link readInventory} — la liste des ports et le rapprochement PoE. Cher (une
 *   poignée de `walk`), stable, relu au rythme **lent** : c'est lui qui réaligne les
 *   `ifIndex` après un redémarrage du switch.
 * - {@link readPortLive} — l'état d'**un** port. Un seul `get` groupé, au rythme rapide.
 *
 * 🔴 Un port = un appareil Homey, donc N appareils interrogent le même switch. Le relevé
 * rapide est donc délibérément un `get` sur une dizaine d'OID et **pas** un `walk` : un
 * `walk` d'`ifTable` par port et par tick, sur un switch 48 ports, ferait quarante-huit
 * parcours complets toutes les dix secondes.
 *
 * `toNumber()` partout : il préserve `null`, et c'est la règle qui évite qu'un port
 * illisible s'affiche comme un port à zéro erreur.
 */

import type { SnmpReader, SnmpValue } from '../snmp/client.mjs';
import { toNumber } from '../snmp/opaque.mjs';
import { trace } from '../snmp/trace.mjs';
import { IF_NUMBER, IF_TABLE, IF_X_TABLE, adminUpOf, isPhysicalPort, linkStateOf, speedMbps } from './if-mib.mjs';
import { PETH_MAIN_TABLE, PETH_PORT_TABLE, poeEnabledOf, poeMainOid, poePortOid, poeRefFromOid, poeStatusOf, type PoePortRef } from './poe-mib.mjs';
import { groupsOf, mapPoePorts, type PoeMapping } from './poe-index.mjs';
import type { PoeReading, PortIdentity, PortLive } from './port.mjs';

/** Ce qu'un switch est, vu de l'app. */
export interface SwitchInventory {
  /** Les prises physiques, dans l'ordre de l'agent. Les seules qu'on propose au pairing. */
  ports: PortIdentity[];
  /** Le débit négocié par port, relevé en même temps que l'inventaire. */
  speeds: ReadonlyMap<number, number | null>;
  /** Combien d'interfaces l'agent déclare en tout, physiques ou non. */
  interfaceCount: number;
  /** `null` quand aucune correspondance PoE ne tient — voir `poe-index.mts`. */
  poe: PoeMapping | null;
}

/** Un inventaire vide, pour une adresse qui n'a rien à dire. */
export const EMPTY_INVENTORY: SwitchInventory = {
  ports: [],
  speeds: new Map(),
  interfaceCount: 0,
  poe: null,
};

/**
 * Combien de prises physiques il faut pour parler de switch.
 *
 * 🔴 **Tout agent SNMP a une IF-MIB** : un NAS, une imprimante, un onduleur. La présence
 * de la MIB ne prouve donc rien. Un poste a une ou deux interfaces physiques ; un switch
 * en a au moins quatre. Le seuil est une heuristique assumée, et c'est pour ça que la
 * saisie manuelle d'adresse ne la consulte pas : quand l'utilisateur désigne un appareil,
 * on lui montre ses ports, on ne discute pas de ce qu'il est.
 */
export const PORTS_FOR_A_SWITCH = 4;

/**
 * Une adresse ressemble-t-elle à un switch ?
 *
 * Le PoE tranche à lui seul : rien d'autre qu'un switch — ou un injecteur, qu'on est
 * content de piloter aussi — ne publie `pethPsePortTable`.
 */
export function looksLikeSwitch(inventory: SwitchInventory): boolean {
  if (inventory.poe !== null) return true;
  return inventory.ports.length >= PORTS_FOR_A_SWITCH;
}

/**
 * L'inventaire complet : les ports, leur débit, et les prises PoE si on sait les relier.
 *
 * Ne lève pas sur une table absente. Un agent sans `ifXTable` — un v1, un firmware
 * ancien — rend un inventaire sans `ifName` ni `ifAlias`, ce qui est dégradé mais
 * utilisable : `ifDescr` suffit à nommer et à identifier un port.
 */
export async function readInventory(client: SnmpReader): Promise<SwitchInventory> {
  const [descr, type, speed, highSpeed, name, alias, operStatus] = await Promise.all([
    walkColumn(client, IF_TABLE.descr),
    walkColumn(client, IF_TABLE.type),
    walkColumn(client, IF_TABLE.speed),
    walkColumn(client, IF_X_TABLE.highSpeed),
    walkColumn(client, IF_X_TABLE.name),
    walkColumn(client, IF_X_TABLE.alias),
    // 🔴 L'état des liens sert **uniquement** à corroborer la correspondance PoE, et il
    // vient de l'`ifTable` que tout agent conforme sert depuis la RFC 1213. Un parcours
    // de plus au rythme lent : le prix d'une commande qui vise la bonne prise.
    walkColumn(client, IF_TABLE.operStatus),
  ]);

  // `ifDescr` est la seule colonne que tout agent conforme possède depuis RFC 1213 :
  // c'est donc elle qui énumère les interfaces, et non `ifName`, absent en `ifXTable`.
  const indexes = [...new Set([...descr.keys(), ...type.keys()])].sort((a, b) => a - b);

  const ports: PortIdentity[] = [];
  const speeds = new Map<number, number | null>();

  for (const ifIndex of indexes) {
    const ifType = toNumber(type.get(ifIndex) ?? null);
    if (!isPhysicalPort(ifType)) continue;

    ports.push({
      ifIndex,
      name: asText(name.get(ifIndex)),
      description: asText(descr.get(ifIndex)),
      alias: asText(alias.get(ifIndex)),
      type: ifType,
    });
    speeds.set(ifIndex, speedMbps(toNumber(highSpeed.get(ifIndex) ?? null), toNumber(speed.get(ifIndex) ?? null)));
  }

  const declared = toNumber(await one(client, IF_NUMBER));
  const linkUp = ports
    .map((port) => port.ifIndex)
    .filter((ifIndex) => linkStateOf(toNumber(operStatus.get(ifIndex) ?? null)) === 'up');
  const poe = await readPoeMapping(client, ports.map((port) => port.ifIndex), linkUp);

  return {
    ports,
    speeds,
    interfaceCount: declared ?? indexes.length,
    poe,
  };
}

/**
 * Les prises PoE de l'agent, rapprochées des ports physiques.
 *
 * Rend `null` sans bruit quand la branche `pethPsePortTable` n'existe pas : la très
 * grande majorité des switchs domestiques n'ont pas de PoE, et ce n'est pas une anomalie.
 * Rend `null` **aussi** quand la table existe mais qu'aucune correspondance ne tient —
 * et là, c'est tracé, parce que c'est le seul cas où l'utilisateur perd quelque chose.
 */
async function readPoeMapping(
  client: SnmpReader,
  physicalIfIndexes: readonly number[],
  linkUp: readonly number[],
): Promise<PoeMapping | null> {
  let rows: Map<string, SnmpValue>;
  try {
    rows = await client.walk(PETH_PORT_TABLE.detectionStatus);
  } catch {
    return null;
  }

  const refs: PoePortRef[] = [];
  const delivering: PoePortRef[] = [];
  for (const [oid, valeur] of rows) {
    const ref = poeRefFromOid(PETH_PORT_TABLE.detectionStatus, oid);
    if (ref === null) continue;
    refs.push(ref);
    // Le parcours rendait déjà cette valeur ; elle était jetée. C'est elle qui corrobore.
    if (poeStatusOf(toNumber(valeur)) === 'delivering') delivering.push(ref);
  }
  if (refs.length === 0) return null;

  const mapping = mapPoePorts(physicalIfIndexes, refs, { delivering, linkUp });
  if (mapping === null) {
    trace.warn('netswitch', `${client.host} exposes ${refs.length} PoE socket(s) with no safe match to its ${physicalIfIndexes.length} port(s) — PoE not declared`, {
      alimentees: delivering.length,
      liensActifs: linkUp.length,
    });
    return null;
  }

  trace.info('netswitch', `${client.host}: PoE matched by "${mapping.strategy}"`, {
    prises: refs.length,
    groupes: groupsOf(mapping),
  });
  return mapping;
}

/**
 * L'état d'un port, en une requête.
 *
 * Les OID PoE ne sont ajoutés que si une correspondance existe : interroger
 * `pethPsePortDetectionStatus.0.0` sur un switch sans PoE ne coûte rien de plus qu'un
 * `null`, mais ferait croire à la lecture du code qu'une prise a été trouvée.
 */
export async function readPortLive(
  client: SnmpReader,
  ifIndex: number,
  poe: PoePortRef | null,
): Promise<PortLive> {
  const base = [
    `${IF_TABLE.operStatus}.${ifIndex}`,
    `${IF_TABLE.adminStatus}.${ifIndex}`,
    `${IF_TABLE.inErrors}.${ifIndex}`,
    `${IF_TABLE.outErrors}.${ifIndex}`,
    `${IF_X_TABLE.hcInOctets}.${ifIndex}`,
    `${IF_X_TABLE.hcOutOctets}.${ifIndex}`,
    `${IF_X_TABLE.discontinuityTime}.${ifIndex}`,
    // Le repli 32 bits de l'`ifTable`, demandé dans la même requête que le reste.
    // Beaucoup de switches ne servent pas d'`ifXTable` du tout : sans ces deux colonnes,
    // leur débit reste vide à vie alors que leurs compteurs d'erreurs, voisins dans la
    // même table, remontent parfaitement. Deux OID de plus dans un `get` déjà groupé ne
    // coûtent rien ; une requête séparée, décidée après coup, coûterait un aller-retour.
    `${IF_TABLE.inOctets}.${ifIndex}`,
    `${IF_TABLE.outOctets}.${ifIndex}`,
  ];
  const poeOids = poe === null ? [] : [
    poePortOid(PETH_PORT_TABLE.detectionStatus, poe),
    poePortOid(PETH_PORT_TABLE.adminEnable, poe),
    poeMainOid(PETH_MAIN_TABLE.consumptionPower, poe.group),
  ];

  const answers = await client.get([...base, ...poeOids]);
  const read = (oid: string): number | null => toNumber(answers.get(oid) ?? null);

  return {
    link: linkStateOf(read(base[0]!)),
    adminUp: adminUpOf(read(base[1]!)),
    errorsIn: read(base[2]!),
    errorsOut: read(base[3]!),
    // 🔴 Le 64 bits d'abord, le 32 bits seulement s'il manque — et jamais un mélange des
    // deux : un `octetsIn` de l'`ifXTable` comparé à un `octetsOut` de l'`ifTable`
    // donnerait deux compteurs de largeurs différentes sur le même port, donc deux règles
    // de débordement contradictoires. C'est l'absence de **toute** valeur — et non un
    // zéro — qui empêchera les capabilities de débit d'être déclarées.
    ...octets(read(base[4]!), read(base[5]!), read(base[7]!), read(base[8]!)),
    discontinuityTicks: read(base[6]!),
    poe: poe === null ? null : poeReading(poe, read(poeOids[0]!), read(poeOids[1]!), read(poeOids[2]!)),
  };
}

/**
 * Choisit la paire de compteurs, sans jamais panacher les largeurs.
 *
 * L'`ifXTable` est préférée quand elle répond : ses compteurs ne débordent pas, donc un
 * recul y est un redémarrage d'agent et non une ambiguïté à trancher. On ne retombe sur
 * l'`ifTable` que lorsque **les deux** valeurs 64 bits manquent — un agent qui n'en
 * servirait qu'une seule est trop douteux pour qu'on complète l'autre depuis une table
 * différente.
 */
function octets(
  hcIn: number | null,
  hcOut: number | null,
  in32: number | null,
  out32: number | null,
): { octetsIn: number | null; octetsOut: number | null; octetsWidth: 32 | 64 } {
  if (hcIn !== null || hcOut !== null) {
    return { octetsIn: hcIn, octetsOut: hcOut, octetsWidth: 64 };
  }
  return { octetsIn: in32, octetsOut: out32, octetsWidth: 32 };
}

function poeReading(
  ref: PoePortRef,
  status: number | null,
  admin: number | null,
  groupPower: number | null,
): PoeReading {
  return {
    ref,
    status: poeStatusOf(status),
    adminEnabled: poeEnabledOf(admin),
    groupPowerWatts: groupPower,
  };
}

/**
 * Le débit négocié d'un port, relu au rythme lent.
 *
 * Il ne bouge qu'au branchement d'un câble, et le relire toutes les dix secondes sur
 * quarante-huit appareils ne ferait qu'ajouter du trafic. `ifHighSpeed` d'abord, pour la
 * raison expliquée dans `if-mib.mts` : `ifSpeed` plafonne.
 */
export async function readPortSpeed(client: SnmpReader, ifIndex: number): Promise<number | null> {
  const oids = [`${IF_X_TABLE.highSpeed}.${ifIndex}`, `${IF_TABLE.speed}.${ifIndex}`];
  const answers = await client.get(oids);
  return speedMbps(toNumber(answers.get(oids[0]!) ?? null), toNumber(answers.get(oids[1]!) ?? null));
}

/**
 * Relit l'identité d'un port, pour vérifier qu'un index désigne encore le même.
 *
 * Deux OID, un seul aller-retour. Appelé juste avant une écriture — voir
 * `lib/netswitch/identity-check.mts` pour la raison, qui n'est pas une précaution
 * générale mais un cas précis : entre deux relevés lents, un index renuméroté ferait
 * couper le mauvais port.
 */
export async function readPortIdentity(
  client: SnmpReader,
  ifIndex: number,
): Promise<{ ifName: string | null; ifDescr: string | null }> {
  const oids = [`${IF_X_TABLE.name}.${ifIndex}`, `${IF_TABLE.descr}.${ifIndex}`];
  const answers = await client.get(oids);
  const texte = (oid: string): string | null => {
    const v = answers.get(oid);
    if (v === null || v === undefined) return null;
    const t = (Buffer.isBuffer(v) ? v.toString('latin1') : String(v)).trim();
    return t.length > 0 ? t : null;
  };
  return { ifName: texte(oids[0]!), ifDescr: texte(oids[1]!) };
}

// ---------------------------------------------------------------------------
// Petits outils
// ---------------------------------------------------------------------------

/**
 * Parcourt une colonne et rend ses lignes indexées par le suffixe entier de l'OID.
 *
 * Une table absente rend une map vide plutôt que de lever : `ifXTable` manque sur les
 * agents anciens, et son absence ne doit pas coûter l'inventaire entier.
 */
async function walkColumn(client: SnmpReader, column: string): Promise<Map<number, SnmpValue>> {
  let rows: Map<string, SnmpValue>;
  try {
    rows = await client.walk(column);
  } catch {
    return new Map();
  }

  const out = new Map<number, SnmpValue>();
  for (const [oid, value] of rows) {
    const index = indexOf(column, oid);
    if (index !== null) out.set(index, value);
  }
  return out;
}

/** Le suffixe entier d'un OID de colonne. `null` si l'OID n'appartient pas à la colonne. */
export function indexOf(column: string, oid: string): number | null {
  if (!oid.startsWith(`${column}.`)) return null;
  const suffix = oid.slice(column.length + 1);
  // Un seul sous-identifiant : `ifTable` et `ifXTable` sont indexées par le seul `ifIndex`.
  if (!/^\d+$/.test(suffix)) return null;
  const index = Number(suffix);
  return Number.isSafeInteger(index) ? index : null;
}

/** Un scalaire, sans faire tomber l'inventaire s'il manque. */
async function one(client: SnmpReader, oid: string): Promise<SnmpValue> {
  try {
    return (await client.get([oid])).get(oid) ?? null;
  } catch {
    return null;
  }
}

/** Une valeur d'agent en texte utilisable, ou `null`. Jamais une chaîne vide. */
function asText(value: SnmpValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = (Buffer.isBuffer(value) ? value.toString('latin1') : String(value)).trim();
  return text === '' ? null : text;
}

// ---------------------------------------------------------------------------
// L'identité du switch
// ---------------------------------------------------------------------------

/** `sysName.0` — le nom que l'agent se donne, et donc celui que l'utilisateur reconnaît. */
const SYS_NAME = '1.3.6.1.2.1.1.5.0';
/** `sysDescr.0` — ce que l'appareil dit être. */
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
/**
 * `entPhysicalSerialNum.1` — ENTITY-MIB (RFC 4133), l'entité racine du châssis.
 *
 * La plupart des switchs administrables la publient, et c'est la seule identité qui
 * survive à un renommage. L'index `.1` est l'entité racine par convention ; un châssis
 * modulaire en publie d'autres, mais la racine est celle qui désigne l'appareil.
 * Absente sur beaucoup de switchs non administrables — auquel cas on retombe sur le nom.
 */
const ENT_SERIAL = '1.3.6.1.2.1.47.1.1.1.1.11.1';

export interface SwitchIdentity {
  name: string | null;
  description: string | null;
  serial: string | null;
}

/** Qui est cet appareil. Ne lève pas : une identité absente coûte un nom, pas l'appairage. */
export async function readSwitchIdentity(client: SnmpReader): Promise<SwitchIdentity> {
  const oids = [SYS_NAME, SYS_DESCR, ENT_SERIAL];
  let answers: Map<string, SnmpValue>;
  try {
    answers = await client.get(oids);
  } catch {
    return { name: null, description: null, serial: null };
  }
  return {
    name: asText(answers.get(SYS_NAME)),
    description: asText(answers.get(SYS_DESCR)),
    serial: asText(answers.get(ENT_SERIAL)),
  };
}
