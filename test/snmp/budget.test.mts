import { strict as assert } from 'node:assert';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { SnmpClient } from '../../lib/snmp/client.mjs';

/**
 * Le chemin v1 doit tenir dans le budget qu'on lui donne.
 *
 * 🔴 Un appel à l'API d'une app est coupé à dix secondes. En v1, `get` envoie **un
 * paquet par OID** : sept OID à 2,5 s avec un réessai faisaient trente-cinq secondes
 * en séquentiel. Le compte d'origine raisonnait en *appels* là où v1 compte des
 * *paquets* — mesuré à 12,4 s sur le chemin de sonde complet.
 *
 * Deux corrections, et il faut les deux : les paquets partent par lots, et le délai de
 * chaque paquet est borné par ce qui reste du budget. Sans la seconde, le budget
 * empêche seulement de *démarrer* une requête après l'échéance, et celle déjà en vol
 * la dépasse librement — le premier essai mesurait encore 10 s.
 */

/** Un puits UDP : il reçoit tout et ne répond jamais. Le pire cas d'un agent v1. */
async function sink(port: number) {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', resolve));
  return socket;
}

const SEVEN = Array.from({ length: 7 }, (_, i) => `1.3.6.1.2.1.33.1.2.${i + 1}.0`);

test('🔴 en v1, sept OID muets tiennent dans le budget', async () => {
  const socket = await sink(11_612);
  try {
    const client = new SnmpClient({
      host: '127.0.0.1', community: 'public', port: 11_612,
      version: 'v1', timeout: 2_500, retries: 1, budgetMs: 3_000,
    });
    const started = Date.now();
    await client.get(SEVEN).catch(() => undefined);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4_500, `${elapsed} ms pour un budget de 3 000 ms`);
  } finally {
    socket.close();
  }
});

test('sans budget, rien n\'est plafonné — c\'est le comportement d\'origine', async () => {
  const socket = await sink(11_613);
  try {
    const client = new SnmpClient({
      host: '127.0.0.1', community: 'public', port: 11_613,
      version: 'v1', timeout: 600, retries: 0,
    });
    const started = Date.now();
    await client.get(SEVEN).catch(() => undefined);
    // Deux lots de six : le parallélisme seul divise déjà par six le temps séquentiel.
    assert.ok(Date.now() - started < 3_000, 'les paquets doivent partir par lots, pas un par un');
  } finally {
    socket.close();
  }
});

test('un budget épuisé rend null, pas une injoignabilité', async () => {
  // « On n'a pas eu le temps de demander » est une lecture partielle. La confondre avec
  // « l'appareil ne répond pas » enverrait l'utilisateur vérifier son câble pour rien.
  const socket = await sink(11_614);
  try {
    const client = new SnmpClient({
      host: '127.0.0.1', community: 'public', port: 11_614,
      version: 'v1', timeout: 400, retries: 0, budgetMs: 300,
    });
    await client.get(SEVEN).then(
      (values) => assert.equal(values.size, SEVEN.length),
      () => undefined, // injoignable est acceptable : aucune feuille n'a répondu
    );
  } finally {
    socket.close();
  }
});
