import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as snmp from 'net-snmp';
import { SnmpWriteError, writeVarbinds } from '../../lib/netswitch/writer.mjs';
import type { PortWrite } from '../../lib/netswitch/control.mjs';

/**
 * Le seul code de cette app qui coupe du courant, et il n'avait aucun test.
 *
 * 🔴 `writeVarbinds` était mentionné une seule fois dans `test/` — par un garde-fou qui
 * cherche une chaîne dans le **source** et n'exécute jamais la fonction. Sa couverture
 * comportementale était donc nulle, sur la fonction qui éteint un port de switch et
 * l'alimentation PoE d'une prise.
 *
 * Et la branche la plus fragile est celle que son propre commentaire décrit comme le cas
 * **normal** : un agent qui accepte la requête et refuse le varbind. Presque tous les
 * agents distinguent une communauté d'écriture d'une communauté de lecture, et `public`
 * est en lecture seule sur la totalité d'entre eux — le refus est donc la règle, pas
 * l'exception. Sans le contrôle des lignes 86-90, une commande refusée serait annoncée
 * comme exécutée : la carte de Flow rapporterait un succès, et le port resterait allumé.
 *
 * Ces essais passent par un vrai agent en boucle locale plutôt que par un double : c'est
 * `net-snmp` qui décide de ce qu'est un varbind en erreur, et un double ne ferait que
 * répéter ce que le test croit déjà.
 */

const OID_RW = '1.3.6.1.4.1.99999.10.1.0';
const OID_RO = '1.3.6.1.4.1.99999.10.2.0';
/** Un OID que l'agent ne connaît pas du tout — cf. le test du varbind refusé. */
const OID_ABSENT = '1.3.6.1.4.1.99999.77.7.0';

/** Un agent avec un objet inscriptible et un objet en lecture seule. */
async function agent(port: number) {
  const a = snmp.createAgent({ port }, () => {});
  a.getAuthorizer().addCommunity('private');
  const mib = a.getMib();

  for (const [nom, oid, acces] of [
    ['inscriptible', OID_RW, snmp.MaxAccess['read-write']],
    ['lectureSeule', OID_RO, snmp.MaxAccess['read-only']],
  ] as const) {
    mib.registerProvider({
      name: nom,
      type: snmp.MibProviderType.Scalar,
      oid: oid.replace(/\.0$/, ''),
      scalarType: snmp.ObjectType.Integer,
      maxAccess: acces,
    });
    mib.setScalarValue(nom, 1);
  }
  return { agent: a, mib };
}

const options = (port: number, community = 'private') => ({
  host: '127.0.0.1', community, version: 'v2c' as const, port, timeout: 1_500, retries: 0,
});

const write = (oid: string, value: number): PortWrite => ({ oid, value } as PortWrite);

test('🔴 une écriture acceptée change réellement la valeur chez l’agent', async () => {
  const { agent: a, mib } = await agent(11_620);
  try {
    await writeVarbinds(options(11_620), [write(OID_RW, 2)]);
    assert.equal(mib.getScalarValue('inscriptible'), 2, 'l’agent doit avoir pris la valeur');
  } finally {
    a.close();
  }
});

/**
 * 🔴 Le cas où la requête **réussit** et l'objet refuse — la seule branche que ce fichier
 * traite en propre, et la seule qu'un test naïf rate.
 *
 * Mesuré contre un vrai agent : écrire sur un objet en **lecture seule** lève une
 * `RequestFailedError: NoAccess` au niveau du transport, donc l'autre branche. C'est
 * écrire sur un OID que l'agent **ne connaît pas** qui rend une réponse sans erreur mais
 * dont le varbind porte `NoSuchObject`.
 *
 * Et ce cas-là n'a rien d'artificiel : c'est celui d'une commande PoE envoyée à un switch
 * qui n'implémente pas POWER-ETHERNET-MIB. Sans le contrôle du varbind, la carte de Flow
 * annoncerait « alimentation coupée » sur une prise qui n'a jamais reçu l'ordre.
 *
 * Vérifié par mutation : retirer ce contrôle fait tomber ce test, et lui seul.
 */
test('🔴 un varbind refusé rejette, il ne résout pas en silence', async () => {
  const { agent: a } = await agent(11_621);
  try {
    await assert.rejects(
      () => writeVarbinds(options(11_621), [write(OID_ABSENT, 2)]),
      (e: unknown) => {
        assert.ok(e instanceof SnmpWriteError, `attendu SnmpWriteError, reçu ${String(e)}`);
        assert.match(e.message, /127\.0\.0\.1/, 'le message doit nommer l’hôte');
        return true;
      },
    );
  } finally {
    a.close();
  }
});

test('🔴 un objet en lecture seule rejette aussi, par l’autre branche', async () => {
  // Celui-ci passe par l'erreur de transport (`NoAccess`). Les deux chemins doivent
  // rejeter : c'est la même conséquence pour l'utilisateur, une commande non exécutée.
  const { agent: a, mib } = await agent(11_624);
  try {
    await assert.rejects(() => writeVarbinds(options(11_624), [write(OID_RO, 2)]), SnmpWriteError);
    assert.equal(mib.getScalarValue('lectureSeule'), 1, 'la valeur ne doit pas avoir bougé');
  } finally {
    a.close();
  }
});

test('🔴 une communauté sans droit d’écriture rejette', async () => {
  // La cause la plus fréquente en pratique : `public` est en lecture seule partout.
  const { agent: a } = await agent(11_622);
  try {
    await assert.rejects(
      () => writeVarbinds(options(11_622, 'public'), [write(OID_RW, 2)]),
      SnmpWriteError,
    );
  } finally {
    a.close();
  }
});

test('un hôte injoignable rejette au lieu de rester en suspens', async () => {
  // Aucun réessai : une commande d'alimentation ne se rejoue pas toute seule.
  await assert.rejects(
    () => writeVarbinds(options(11_623), [write(OID_RW, 2)]),
    SnmpWriteError,
  );
});

test('une liste d’écritures vide n’ouvre aucune session', async () => {
  // Le port 1 est privilégié et rien n'y écoute : si la fonction ouvrait quand même une
  // session, cet appel mettrait le temps du timeout à échouer au lieu de rendre la main.
  const debut = Date.now();
  await writeVarbinds(options(1), []);
  assert.ok(Date.now() - debut < 200, 'doit rendre la main immédiatement');
});
