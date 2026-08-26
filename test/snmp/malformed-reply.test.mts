import { strict as assert } from 'node:assert';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { SnmpClient } from '../../lib/snmp/client.mjs';
import { writeVarbinds } from '../../lib/netswitch/writer.mjs';

/**
 * 🔴 Un datagramme illisible ne doit pas tuer l'app.
 *
 * Rapport de plantage d'un utilisateur, v1.0.8 sur Homey Pro (2026) :
 *
 *     TypeError: Value read as integer null is not an integer
 *         at readInt32 (net-snmp/index.js:412)
 *         at Message.createFromBuffer (net-snmp/index.js:1954)
 *         at Session.onMsg (net-snmp/index.js:2415)
 *         at Socket.emit (node:events)
 *         at UDP.onMessage (node:dgram)
 *
 * `Session.onMsg` attrape pourtant l'échec de parsage — et le ré-émet en
 * `this.emit("error", error)`. C'est là que tout se joue : un `EventEmitter` Node qui
 * émet `'error'` **sans écouteur** relance l'objet d'erreur tel quel, avec sa trace
 * d'origine. L'exception naît donc dans un gestionnaire d'événement dgram, hors de
 * toute chaîne de promesses : ni le `try/catch` autour du `get`, ni le `.catch()` du
 * relevé ne la voient passer. Le processus de l'app meurt.
 *
 * Il suffit d'un paquet UDP mal formé arrivant sur le port éphémère d'une session pour
 * déclencher ça — un firmware bavard, un service tiers qui répond à côté, ou l'une des
 * 254 adresses du balayage réseau qui renvoie autre chose que du SNMP. Rien de tout
 * cela n'est sous notre contrôle, et rien de tout cela ne justifie de perdre l'app.
 */

/**
 * Une SEQUENCE vide : `0x30 0x00`.
 *
 * Charge utile choisie en mesurant, pas en devinant. `Message.createFromBuffer` lit une
 * séquence puis `version = readInt32(reader)`. Avec une séquence vide il ne reste rien à
 * lire, `reader.readInt()` rend `null`, et `readInt32` lève très exactement le
 * `TypeError: Value read as integer null is not an integer` du rapport de plantage.
 *
 * Deux candidats plus « abîmés » ne conviennent **pas**, et c'est instructif :
 * `30 03 04 01 41` se lit comme `version = 65` et poursuit tranquillement, parce que
 * `readInt()` accepte n'importe quelle étiquette ; `30 02 02 00` lève une autre erreur,
 * `Zero-length integer`, qui elle emprunte un chemin propre.
 */
const ILLISIBLE = Buffer.from([0x30, 0x00]);

/** Un faux agent qui répond des octets qu'aucun parseur SNMP n'acceptera. */
async function agentBavard(port: number): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (_message, remote) => {
    socket.send(ILLISIBLE, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', resolve));
  return socket;
}

/**
 * Sans écouteur `'error'`, ce test ne échoue pas : il **tue le processus de test**,
 * exactement comme il tue l'app. C'est ce qui en fait une reproduction fidèle.
 */
test('🔴 une réponse illisible fait échouer la requête, pas l’app', async () => {
  const socket = await agentBavard(11_631);
  try {
    const client = new SnmpClient({
      host: '127.0.0.1', community: 'public', port: 11_631,
      version: 'v2c', timeout: 300, retries: 0,
    });

    await assert.rejects(
      () => client.get(['1.3.6.1.2.1.1.1.0']),
      (error: Error) => {
        assert.ok(
          /injoignable|unreachable|imeout/i.test(`${error.name} ${error.message}`),
          `attendu un échec de requête, reçu : ${error.name} — ${error.message}`,
        );
        return true;
      },
    );
  } finally {
    socket.close();
  }
});

test('🔴 le parcours de table survit lui aussi à une réponse illisible', async () => {
  const socket = await agentBavard(11_632);
  try {
    const client = new SnmpClient({
      host: '127.0.0.1', community: 'public', port: 11_632,
      version: 'v2c', timeout: 300, retries: 0,
    });
    await assert.rejects(() => client.walk('1.3.6.1.2.1.2.2.1'));
  } finally {
    socket.close();
  }
});

/**
 * L'écriture ouvre sa propre session, dans `lib/netswitch/writer.mts`. Elle est exposée
 * au même paquet, et une commande PoE ne doit pas plus tuer l'app qu'un relevé.
 */
test('🔴 l’écriture survit elle aussi à une réponse illisible', async () => {
  const socket = await agentBavard(11_633);
  try {
    await assert.rejects(() => writeVarbinds(
      { host: '127.0.0.1', community: 'private', port: 11_633, version: 'v2c', timeout: 300, retries: 0 },
      [{ oid: '1.3.6.1.2.1.2.2.1.7.1', type: 'integer', value: 1 }],
    ));
  } finally {
    socket.close();
  }
});

/**
 * 🔴 Aucune session ne doit échapper au garde.
 *
 * Le correctif ne tient qu'aussi longtemps que **chaque** `createSession` est enveloppé.
 * Une troisième session ajoutée un jour sans `guardSession` rouvrirait exactement le même
 * plantage, sur un chemin que les trois tests ci-dessus ne parcourent pas — et rien dans
 * le typage ni dans la validation ne le signalerait.
 */
test('🔴 chaque createSession passe par guardSession', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  function fichiers(racine: string): string[] {
    const sortie: string[] = [];
    for (const entree of readdirSync(racine, { withFileTypes: true })) {
      const chemin = join(racine, entree.name);
      if (entree.isDirectory()) sortie.push(...fichiers(chemin));
      else if (entree.name.endsWith('.mts')) sortie.push(chemin);
    }
    return sortie;
  }

  const racine = process.cwd();
  const nus: string[] = [];
  let total = 0;

  for (const chemin of [...fichiers(join(racine, 'lib')), ...fichiers(join(racine, 'drivers'))]) {
    for (const [index, ligne] of readFileSync(chemin, 'utf8').split('\n').entries()) {
      if (!/\bsnmp\.createSession\s*\(/.test(ligne)) continue;
      total += 1;
      if (!/guardSession\s*\(\s*snmp\.createSession/.test(ligne)) {
        nus.push(`${chemin.slice(racine.length + 1)}:${index + 1} — ${ligne.trim()}`);
      }
    }
  }

  assert.ok(total >= 2, `seulement ${total} createSession trouvés — ce garde ne prouverait plus rien`);
  assert.deepEqual(
    nus,
    [],
    'session SNMP créée sans guardSession : un paquet UDP illisible y tuerait l’app\n'
    + nus.join('\n'),
  );
});

/**
 * 🔴 Le datagramme avalé doit ressortir dans le message d'échec.
 *
 * Le garde empêche le plantage, mais il rend l'appareil bavard **invisible** : la requête
 * va à son délai et l'app annonce « No SNMP answer », exactement comme pour une adresse
 * morte. L'utilisateur va donc vérifier son adresse et sa communauté, et cherche là où il
 * n'y a rien — le symptôme réel étant un appareil qui répond du charabia.
 *
 * L'idée vient de l'app imprimante, qui a subi le même plantage et a eu la bonne réaction
 * avant nous. On y ajoute une chose : le champ est remis à zéro à chaque opération. Le
 * garder d'une opération à l'autre collerait un incident vieux de dix minutes sur un délai
 * qui n'a rien à voir, et un faux indice est pire que pas d'indice.
 */
test('🔴 le message d’échec nomme le datagramme illisible', async () => {
  const socket = await agentBavard(11_641);
  try {
    const client = new SnmpClient({
      host: '127.0.0.1', community: 'public', port: 11_641,
      version: 'v2c', timeout: 300, retries: 0,
    });
    await assert.rejects(
      () => client.get(['1.3.6.1.2.1.1.1.0']),
      (error: Error) => {
        assert.match(
          error.message,
          /unreadable reply also arrived/i,
          `l’appareil bavard reste indiscernable d’une adresse morte : ${error.message}`,
        );
        return true;
      },
    );
  } finally {
    socket.close();
  }
});

test('🔴 une adresse simplement muette n’invente pas de datagramme', async () => {
  // Le pendant du test précédent : sans charabia reçu, le message ne doit rien ajouter.
  // Sans ce contrôle, un champ jamais remis à zéro passerait le test ci-dessus.
  const muet = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => muet.bind(11_642, '127.0.0.1', resolve));
  try {
    const client = new SnmpClient({
      host: '127.0.0.1', community: 'public', port: 11_642,
      version: 'v2c', timeout: 300, retries: 0,
    });
    await assert.rejects(
      () => client.get(['1.3.6.1.2.1.1.1.0']),
      (error: Error) => {
        assert.doesNotMatch(error.message, /unreadable reply/i, error.message);
        return true;
      },
    );
  } finally {
    muet.close();
  }
});

test('🔴 le datagramme d’une opération ne contamine pas la suivante', async () => {
  // Le même client sert deux fois : d'abord contre l'agent bavard, puis contre une
  // adresse muette. Le second échec ne doit pas hériter du charabia du premier.
  const bavard = await agentBavard(11_643);
  const client = new SnmpClient({
    host: '127.0.0.1', community: 'public', port: 11_643,
    version: 'v2c', timeout: 300, retries: 0,
  });
  try {
    await client.get(['1.3.6.1.2.1.1.1.0']).catch(() => undefined);
  } finally {
    bavard.close();
  }

  const muet = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => muet.bind(11_643, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () => client.get(['1.3.6.1.2.1.1.1.0']),
      (error: Error) => {
        assert.doesNotMatch(
          error.message,
          /unreadable reply/i,
          `un incident de l’opération précédente est recollé sur celle-ci : ${error.message}`,
        );
        return true;
      },
    );
  } finally {
    muet.close();
  }
});
