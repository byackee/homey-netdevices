/**
 * Le seul chemin d'écriture SNMP du dépôt.
 *
 * 🔴 Il vit ici, et **pas** dans `lib/snmp/client.mts`, délibérément. Le transport commun
 * est partagé par tous les drivers, dont l'onduleur, où `upsControl` de la RFC 1628
 * couperait l'alimentation de tout ce qui est branché — ce Homey compris. Lui ajouter un
 * `set()` mettrait cette capacité à portée d'un driver qui n'en veut à aucun prix. Ici,
 * elle n'est atteignable que depuis `drivers/netswitch/`, et seulement après une décision
 * de `control.mts`.
 *
 * Rien de ce fichier ne décide quoi que ce soit : il reçoit des varbinds déjà validés et
 * les émet. La décision est ailleurs, et elle est testée.
 */

// Import de namespace : `net-snmp` est du CommonJS et ne publie pas d'export par défaut.
import * as snmp from 'net-snmp';

import type { SnmpVersion } from '../snmp/client.mjs';
import { trace } from '../snmp/trace.mjs';
import type { PortWrite } from './control.mjs';

export interface WriterOptions {
  host: string;
  /**
   * La communauté d'écriture.
   *
   * ⚠️ Presque tous les agents distinguent une communauté de lecture d'une communauté
   * d'écriture, et `public` est en lecture seule sur la totalité d'entre eux. Un SET qui
   * échoue par communauté insuffisante est donc le cas **normal**, pas l'exception : le
   * message d'erreur doit le dire, sans quoi l'utilisateur ira chercher un bug ailleurs.
   */
  community: string;
  version: SnmpVersion;
  timeout?: number;
  retries?: number;
  port?: number;
}

const DEFAULT_TIMEOUT = 4_000;
/** Aucun réessai : une commande d'alimentation ne se rejoue pas toute seule. */
const DEFAULT_RETRIES = 0;
const DEFAULT_PORT = 161;

/** Levée quand l'agent a refusé l'écriture — droits, objet en lecture seule, valeur hors bornes. */
export class SnmpWriteError extends Error {
  constructor(host: string, cause: string) {
    super(`L'agent ${host} a refusé l'écriture : ${cause}`);
    this.name = 'SnmpWriteError';
  }
}

/**
 * Émet des varbinds déjà décidés.
 *
 * Une session par appel, comme en lecture : un socket à longue vie ne survit ni au
 * redémarrage de l'app ni au changement d'adresse de l'appareil.
 */
export async function writeVarbinds(options: WriterOptions, writes: readonly PortWrite[]): Promise<void> {
  if (writes.length === 0) return;

  const session = snmp.createSession(options.host, options.community, {
    version: options.version === 'v1' ? snmp.Version1 : snmp.Version2c,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
    port: options.port ?? DEFAULT_PORT,
  });

  const varbinds = writes.map((write) => ({
    oid: write.oid,
    type: snmp.ObjectType.Integer,
    value: write.value,
  }));

  trace.warn('netswitch', `écriture SNMP sur ${options.host}`, varbinds.map((v) => `${v.oid}=${String(v.value)}`));

  try {
    await new Promise<void>((resolve, reject) => {
      session.set(varbinds, (error, result) => {
        if (error) {
          reject(new SnmpWriteError(options.host, error.message));
          return;
        }
        // Un agent peut accepter la requête et refuser le varbind : c'est un succès au
        // niveau du transport et un échec au niveau de l'objet. Sans ce contrôle, une
        // commande refusée serait annoncée comme exécutée.
        const refused = (result ?? []).find((vb) => snmp.isVarbindError(vb));
        if (refused) {
          reject(new SnmpWriteError(options.host, snmp.varbindError(refused)));
          return;
        }
        resolve();
      });
    });
  } finally {
    session.close();
  }
}
