import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { SnmpReader, SnmpValue } from '../../lib/snmp/client.mjs';
import { IF_TABLE, IF_X_TABLE } from '../../lib/netswitch/if-mib.mjs';
import { PETH_MAIN_TABLE, PETH_PORT_TABLE } from '../../lib/netswitch/poe-mib.mjs';
import { looksLikeSwitch, readInventory, readPortLive, readSwitchIdentity } from '../../lib/netswitch/reader.mjs';

/**
 * Un agent SNMP en dur, qui rend ce qu'on lui a écrit et `null` pour le reste.
 *
 * Le point de l'injection : un lecteur qui exige un vrai switch ne se teste pas, donc ne
 * se teste jamais, donc ne prouve rien. `SnmpReader` est une interface pour cette raison
 * exacte.
 */
class FakeAgent implements SnmpReader {
  readonly host = '192.168.1.2';
  /** Les sous-arbres que cet agent ne connaît pas : `walk` y lève, comme le vrai. */
  readonly missing = new Set<string>();
  readonly values = new Map<string, SnmpValue>();

  set(oid: string, value: SnmpValue): this {
    this.values.set(oid, value);
    return this;
  }

  column(column: string, rows: Record<number, SnmpValue>): this {
    for (const [index, value] of Object.entries(rows)) this.values.set(`${column}.${index}`, value);
    return this;
  }

  async get(oids: string[]): Promise<Map<string, SnmpValue>> {
    return new Map(oids.map((oid) => [oid, this.values.get(oid) ?? null]));
  }

  async walk(root: string): Promise<Map<string, SnmpValue>> {
    if (this.missing.has(root)) throw new Error(`no such subtree: ${root}`);
    const out = new Map<string, SnmpValue>();
    for (const [oid, value] of this.values) {
      if (oid.startsWith(`${root}.`)) out.set(oid, value);
    }
    return out;
  }
}

/** Un switch 8 ports : six prises physiques, une boucle locale et un VLAN. */
function switch8(): FakeAgent {
  const agent = new FakeAgent();
  agent.column(IF_TABLE.descr, {
    1: 'GigabitEthernet1/0/1', 2: 'GigabitEthernet1/0/2', 3: 'GigabitEthernet1/0/3',
    4: 'GigabitEthernet1/0/4', 5: 'GigabitEthernet1/0/5', 6: 'GigabitEthernet1/0/6',
    50: 'lo', 60: 'Vlan1',
  });
  agent.column(IF_TABLE.type, { 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: 6, 50: 24, 60: 53 });
  agent.column(IF_X_TABLE.name, { 1: 'Gi1/0/1', 2: 'Gi1/0/2', 3: 'Gi1/0/3', 4: 'Gi1/0/4', 5: 'Gi1/0/5', 6: 'Gi1/0/6' });
  agent.column(IF_X_TABLE.alias, { 5: 'Caméra jardin' });
  // Des débits volontairement distincts, et aucun à 1 Gbit/s : à ce débit précis,
  // `ifHighSpeed` et `ifSpeed / 1e6` donnent le même nombre et ne prouvent rien.
  agent.column(IF_TABLE.speed, { 1: 100_000_000, 2: 4_294_967_295, 3: 0 });
  agent.column(IF_X_TABLE.highSpeed, { 2: 10_000 });
  agent.set('1.3.6.1.2.1.2.1.0', 8);
  return agent;
}

test('l\'inventaire ne garde que les prises physiques', async () => {
  const inventory = await readInventory(switch8());
  assert.deepEqual(inventory.ports.map((p) => p.ifIndex), [1, 2, 3, 4, 5, 6]);
  assert.equal(inventory.interfaceCount, 8, 'ifNumber compte tout, y compris la boucle et le VLAN');
});

test('🔴 un port 10G lit ifHighSpeed, pas le plafond d\'ifSpeed', async () => {
  const inventory = await readInventory(switch8());
  assert.equal(inventory.speeds.get(2), 10_000);
  assert.equal(inventory.speeds.get(1), 100, '100 Mbit/s, converti depuis des bit/s');
  assert.equal(inventory.speeds.get(3), 0, 'un lien qui n\'a pas négocié est une vraie mesure');
});

test('l\'alias de l\'administrateur remonte, quand il y en a un', async () => {
  const inventory = await readInventory(switch8());
  assert.equal(inventory.ports.find((p) => p.ifIndex === 5)?.alias, 'Caméra jardin');
  assert.equal(inventory.ports.find((p) => p.ifIndex === 1)?.alias, null, 'pas de chaîne vide');
});

test('🔴 un agent sans ifXTable donne un inventaire dégradé, pas un inventaire vide', async () => {
  // Un firmware ancien, ou du v1 : `ifDescr` suffit à nommer et à identifier un port.
  const agent = switch8();
  agent.missing.add(IF_X_TABLE.name);
  agent.missing.add(IF_X_TABLE.alias);
  agent.missing.add(IF_X_TABLE.highSpeed);

  const inventory = await readInventory(agent);
  assert.equal(inventory.ports.length, 6);
  assert.equal(inventory.ports[0]?.name, null);
  assert.equal(inventory.ports[0]?.description, 'GigabitEthernet1/0/1');
  assert.equal(inventory.speeds.get(1), 100, 'ifSpeed reste lisible sans ifXTable');
});

test('sans PoE, aucune correspondance — et ce n\'est pas une anomalie', async () => {
  const agent = switch8();
  agent.missing.add(PETH_PORT_TABLE.detectionStatus);
  assert.equal((await readInventory(agent)).poe, null);
});

test('le PoE est rapproché quand pethPsePortIndex vaut ifIndex', async () => {
  const agent = switch8();
  agent.column(`${PETH_PORT_TABLE.detectionStatus}.1`, { 1: 3, 2: 2, 3: 1, 4: 1, 5: 3, 6: 1 });
  const inventory = await readInventory(agent);
  assert.equal(inventory.poe?.strategy, 'identity');
  assert.deepEqual(inventory.poe?.byIfIndex.get(5), { group: 1, port: 5 });
});

test('🔴 des prises PoE qui ne se rapprochent pas ne sont pas déclarées au jugé', async () => {
  const agent = switch8();
  // Trois prises sur six ports, numérotées hors de l'espace des ifIndex : ni l'identité
  // ni le rang ne tiennent.
  agent.column(`${PETH_PORT_TABLE.detectionStatus}.1`, { 101: 3, 102: 3, 103: 3 });
  assert.equal((await readInventory(agent)).poe, null);
});

test('looksLikeSwitch : le PoE tranche seul, et quatre prises suffisent sinon', async () => {
  const many = await readInventory(switch8());
  assert.equal(looksLikeSwitch(many), true);

  const agent = new FakeAgent();
  agent.column(IF_TABLE.descr, { 1: 'eth0', 2: 'eth1' });
  agent.column(IF_TABLE.type, { 1: 6, 2: 6 });
  agent.missing.add(PETH_PORT_TABLE.detectionStatus);
  const twoPorts = await readInventory(agent);
  assert.equal(looksLikeSwitch(twoPorts), false, 'un NAS a deux interfaces, ce n\'est pas un switch');

  agent.column(`${PETH_PORT_TABLE.detectionStatus}.1`, { 1: 3, 2: 3 });
  agent.missing.delete(PETH_PORT_TABLE.detectionStatus);
  assert.equal(looksLikeSwitch(await readInventory(agent)), true, 'du PoE, donc un switch ou un injecteur');
});

test('le relevé rapide lit les bons OID, et rend null pour ce qui manque', async () => {
  const agent = switch8();
  agent.set(`${IF_TABLE.operStatus}.5`, 1);
  agent.set(`${IF_TABLE.adminStatus}.5`, 1);
  agent.set(`${IF_TABLE.inErrors}.5`, 17);
  agent.set(`${IF_TABLE.outErrors}.5`, 3);
  agent.set(`${IF_X_TABLE.hcInOctets}.5`, 12_500_000);
  agent.set(`${IF_X_TABLE.hcOutOctets}.5`, 25_000_000);
  agent.set(`${IF_X_TABLE.discontinuityTime}.5`, 0);
  agent.set(`${PETH_PORT_TABLE.detectionStatus}.1.5`, 3);
  agent.set(`${PETH_PORT_TABLE.adminEnable}.1.5`, 1);
  agent.set(`${PETH_MAIN_TABLE.consumptionPower}.1`, 41.5);

  const live = await readPortLive(agent, 5, { group: 1, port: 5 });
  assert.equal(live.link, 'up');
  assert.equal(live.adminUp, true);
  assert.equal(live.errorsIn, 17);
  assert.equal(live.errorsOut, 3, 'les deux sens ne doivent pas être branchés sur le même OID');
  assert.equal(live.octetsIn, 12_500_000);
  assert.equal(live.octetsOut, 25_000_000);
  assert.equal(live.poe?.status, 'delivering');
  assert.equal(live.poe?.groupPowerWatts, 41.5);
});

test('🔴 en v1, les Counter64 sont absents : ils restent null, jamais zéro', async () => {
  const agent = switch8();
  agent.set(`${IF_TABLE.operStatus}.5`, 1);
  // ni hcInOctets ni hcOutOctets : c'est exactement ce que rend un agent v1.
  const live = await readPortLive(agent, 5, null);
  assert.equal(live.octetsIn, null);
  assert.equal(live.octetsOut, null);
  assert.notEqual(live.octetsIn, 0);
});

test('sans correspondance PoE, aucun OID PoE n\'est même demandé', async () => {
  const agent = switch8();
  agent.set(`${PETH_PORT_TABLE.detectionStatus}.0.0`, 3);
  const live = await readPortLive(agent, 5, null);
  assert.equal(live.poe, null);
});

test('l\'identité du switch préfère le numéro de série de l\'ENTITY-MIB', async () => {
  const agent = switch8();
  agent.set('1.3.6.1.2.1.1.5.0', 'sw-garage');
  agent.set('1.3.6.1.2.1.1.1.0', 'Cisco IOS Software, C2960');
  agent.set('1.3.6.1.2.1.47.1.1.1.1.11.1', 'FOC1234X5YZ');

  const identity = await readSwitchIdentity(agent);
  assert.equal(identity.name, 'sw-garage');
  assert.equal(identity.serial, 'FOC1234X5YZ');
  assert.equal(identity.description, 'Cisco IOS Software, C2960');
});

test('une identité absente coûte un nom, pas l\'appairage', async () => {
  const identity = await readSwitchIdentity(new FakeAgent());
  assert.deepEqual(identity, { name: null, description: null, serial: null });
});
