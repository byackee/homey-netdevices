import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import snmp from 'net-snmp';
import { SnmpClient } from '../../lib/snmp/client.mjs';

/**
 * Un parcours doit se terminer, même quand l'agent d'en face ne coopère pas.
 *
 * 🔴 `net-snmp` ne conclut un walk que sur `EndOfMibView` (index.js, `walkCb`). Un agent
 * dont le sous-arbre demandé est simplement **absent** répond `noSuchObject` en réémettant
 * l'OID demandé : il reste dans le sous-arbre, il ne progresse pas, et le `getNext` suivant
 * repart du même point. Ni erreur ni délai d'attente — juste une boucle. Mesuré contre un
 * agent qui ne publie pas ENTITY-SENSOR-MIB : **1 748 200 varbinds en quinze secondes**,
 * et le relevé NAS pendait indéfiniment.
 *
 * Ce n'est pas un cas de laboratoire : la plupart des NAS n'implémentent pas
 * ENTITY-SENSOR-MIB, et c'est précisément la MIB que le lecteur de température parcourt.
 */

/** Un agent qui ne connaît que `sysDescr` — tout le reste de la MIB lui est absent. */
async function bareAgent(port: number) {
  const agent = snmp.createAgent({ port }, () => {});
  agent.getAuthorizer().addCommunity('public');
  const mib = agent.getMib();
  mib.registerProvider({
    name: 'sysDescr',
    type: snmp.MibProviderType.Scalar,
    oid: '1.3.6.1.2.1.1.1',
    scalarType: snmp.ObjectType.OctetString,
    maxAccess: snmp.MaxAccess['read-only'],
  });
  mib.setScalarValue('sysDescr', 'bare');
  return agent;
}

const clientOn = (port: number) =>
  new SnmpClient({ host: '127.0.0.1', community: 'public', port, version: 'v2c', timeout: 1_000 });

test('🔴 un sous-arbre absent termine le parcours au lieu de boucler', async () => {
  const agent = await bareAgent(11_613);
  try {
    const started = Date.now();
    // 1.3.6.1.2.1.99 = ENTITY-SENSOR-MIB, que cet agent ne sert pas.
    const rows = await clientOn(11_613).walk('1.3.6.1.2.1.99');
    const elapsed = Date.now() - started;

    assert.equal(rows.size, 0, 'un sous-arbre absent ne rend aucune feuille');
    assert.ok(elapsed < 2_000, `${elapsed} ms — le parcours a bouclé`);
  } finally {
    agent.close();
  }
});

/**
 * Le contrôle de progression compare les OID **composant par composant**.
 *
 * En ordre lexical de chaînes, `…1.10` précède `…1.2` : une comparaison textuelle
 * verrait reculer l'OID au passage de la neuvième colonne et couperait le parcours.
 * Toute table de dix colonnes ou plus serait tronquée — `ifTable` en a vingt-deux.
 */
test('🔴 une table de plus de neuf colonnes est parcourue en entier', async () => {
  const COLUMNS = 12;
  const agent = await bareAgent(11_614);
  try {
    const mib = agent.getMib();
    mib.registerProvider({
      name: 'wideTable',
      type: snmp.MibProviderType.Table,
      oid: '1.3.6.1.4.1.99999.1.1',
      maxAccess: snmp.MaxAccess['read-only'],
      tableIndex: [{ columnName: 'c1' }],
      tableColumns: Array.from({ length: COLUMNS }, (_, i) => ({
        number: i + 1,
        name: `c${i + 1}`,
        type: snmp.ObjectType.Integer,
        maxAccess: snmp.MaxAccess['read-only'],
      })),
    });
    mib.addTableRow('wideTable', Array.from({ length: COLUMNS }, (_, i) => i + 1));

    const rows = await clientOn(11_614).walk('1.3.6.1.4.1.99999.1.1');
    assert.equal(rows.size, COLUMNS, 'toutes les colonnes remontent');
    assert.equal(rows.get('1.3.6.1.4.1.99999.1.1.12.1'), 12, 'la douzième colonne est là');
  } finally {
    agent.close();
  }
});

/**
 * Un Counter64 doit ressortir en nombre.
 *
 * 🔴 `net-snmp` rend ce type en **Buffer de huit octets** (`readUint64`). Le décodeur en
 * aval ne reconnaît que l'`Opaque Float` propriétaire, long de sept ou onze octets, et
 * rendait donc `null` : `ifHCInOctets` et `ifHCOutOctets` étaient nuls sur tout switch
 * réel, et les capabilities de débit ne pouvaient pas se déclarer. Le simulateur l'a
 * montré ; aucun fixture écrit à la main ne l'aurait fait, puisqu'ils portent déjà des
 * nombres.
 */
test('🔴 un Counter64 ressort en nombre, pas en octets bruts', async () => {
  const agent = await bareAgent(11_615);
  try {
    const mib = agent.getMib();
    mib.registerProvider({
      name: 'hcOctets',
      type: snmp.MibProviderType.Scalar,
      oid: '1.3.6.1.4.1.99999.2',
      scalarType: snmp.ObjectType.Counter64,
      maxAccess: snmp.MaxAccess['read-only'],
    });
    // Huit octets bruts : c'est ainsi que l'agent doit poser un Counter64.
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(8_000_000_000n);
    mib.setScalarValue('hcOctets', bytes);

    const answers = await clientOn(11_615).get(['1.3.6.1.4.1.99999.2.0']);
    assert.equal(answers.get('1.3.6.1.4.1.99999.2.0'), 8_000_000_000);
  } finally {
    agent.close();
  }
});
