/**
 * L'ordre d'essai des sources, et la détection qui s'en sert.
 *
 * Trois dialectes savent décrire le même onduleur, et un appareil donné peut en parler
 * plusieurs : un APC équipé d'une carte AP9631 répond à la fois à la RFC 1628 et à
 * PowerNet, un Synology relaie parfois un onduleur qui a lui-même une carte réseau. Le
 * premier qui répond gagne — donc **l'ordre est une décision**, pas une commodité :
 *
 * 1. **Synology** en premier parce que c'est le chemin que l'utilisateur a explicitement
 *    configuré : il a coché « SNMP » dans DSM et branché son onduleur en USB. Si cette
 *    branche répond, c'est celle qu'il attend de voir.
 * 2. **RFC 1628** ensuite, parce que c'est le standard : ce qu'il rend a la même
 *    signification chez tous les constructeurs, et il porte les tensions et la puissance
 *    qu'APC ne publie pas dans le sous-ensemble vérifié.
 * 3. **APC** en dernier : plus riche sur son propre matériel, mais privé, et truffé de
 *    sentinelles. On n'y vient que si le standard n'a rien donné.
 *
 * QNAP (`UpsSource` `'qnap'`) n'a **pas** de lecteur : l'annexe A §6b le donne pour non
 * confirmé sur du vrai matériel. Le type l'admet, la liste ne le contient pas — c'est
 * précisément ce qu'on veut dire par « on ne déclare que ce qu'on sait lire ».
 */

import { apcUpsSource } from './apc-reader.mjs';
import { rfc1628UpsSource } from './rfc1628-reader.mjs';
import { synologyUpsSource } from './reader.mjs';
import type { SnmpSource, UpsSnapshot, UpsSource, UpsSourceReader } from './snapshot.mjs';

/** L'ordre d'essai. Le premier qui répond gagne. */
export const UPS_SOURCE_READERS: readonly UpsSourceReader[] = [
  synologyUpsSource,
  rfc1628UpsSource,
  apcUpsSource,
];

/** Retrouve un lecteur à partir de la source mémorisée dans le `store` du device. */
export function readerForSource(source: UpsSource): UpsSourceReader | null {
  return UPS_SOURCE_READERS.find((reader) => reader.source === source) ?? null;
}

/** Ce qu'une détection a appris, y compris quand elle n'a rien trouvé. */
export interface UpsDetection {
  /** Le premier lecteur qui a reconnu l'appareil, ou `null`. */
  reader: UpsSourceReader | null;
  /** Les sources qui ont répondu « ce n'est pas mon dialecte », proprement. */
  declined: UpsSource[];
  /** Les sources dont la sonde a échoué en transport, avec leur erreur. */
  failed: { source: UpsSource; error: unknown }[];
}

/**
 * Cherche laquelle des trois sources cet appareil parle.
 *
 * 🔴 Le point délicat est de **distinguer « ce n'est pas un onduleur » de « il ne répond
 * pas »**. Les deux donnent zéro sonde positive, et les confondre coûte cher dans les
 * deux sens : dire « aucun onduleur trouvé » sur un appareil simplement injoignable
 * envoie l'utilisateur chercher un problème de MIB alors que sa communauté SNMP est
 * fausse ; dire « injoignable » d'un appareil qui a répondu poliment l'envoie vérifier
 * son câble.
 *
 * La règle : une sonde qui **répond** « non » est une information ; une sonde qui
 * **échoue** n'en est pas une. Si toutes ont échoué, l'appareil est injoignable et
 * l'erreur remonte telle quelle — c'est au device, et à lui seul, de décider si ça vaut
 * « indisponible » (plan §3.8). Si au moins une a répondu, l'appareil est joignable et
 * ne parle simplement aucun de nos dialectes : `reader` vaut `null`, sans erreur.
 */
export async function detectUpsSource(client: SnmpSource): Promise<UpsDetection> {
  const declined: UpsSource[] = [];
  const failed: { source: UpsSource; error: unknown }[] = [];

  for (const reader of UPS_SOURCE_READERS) {
    try {
      if (await reader.probe(client)) return { reader, declined, failed };
      declined.push(reader.source);
    } catch (error) {
      failed.push({ source: reader.source, error });
    }
  }

  if (declined.length === 0 && failed.length > 0) throw failed[0]!.error;
  return { reader: null, declined, failed };
}

/**
 * Un cycle complet, en trois requêtes.
 *
 * Réservé au pairing et au rythme lent : le device n'appelle **pas** ça toutes les dix
 * secondes, il appelle `readLive()`. Le nom le dit — un snapshot, c'est tout ce qu'on
 * sait à un instant, pas ce qu'on relit sans cesse.
 */
export async function readUpsSnapshot(reader: UpsSourceReader, client: SnmpSource): Promise<UpsSnapshot> {
  const [identity, live, detail] = await Promise.all([
    reader.readIdentity(client),
    reader.readLive(client),
    reader.readDetail(client),
  ]);
  return { source: reader.source, ...identity, ...live, ...detail };
}
