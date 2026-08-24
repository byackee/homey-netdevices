import type snmp from 'net-snmp';
import { trace } from './trace.mjs';

/**
 * 🔴 Pose l'écouteur `'error'` sans lequel un paquet UDP illisible tue l'app.
 *
 * Rapport d'un utilisateur, v1.0.8 sur Homey Pro (2026) :
 *
 *     TypeError: Value read as integer null is not an integer
 *         at readInt32 (net-snmp/index.js:412)
 *         at Message.createFromBuffer (net-snmp/index.js:1954)
 *         at Session.onMsg (net-snmp/index.js:2415)
 *         at Socket.emit (node:events) / UDP.onMessage (node:dgram)
 *
 * Le piège est que `net-snmp` gère déjà l'échec de parsage — `onMsg` l'attrape et le
 * ré-émet en `this.emit("error", error)`. Mais `Session` hérite d'`EventEmitter`, et un
 * `EventEmitter` Node qui émet `'error'` **sans écouteur** relance l'objet tel quel.
 * L'exception ressort donc dans un gestionnaire d'événement dgram, hors de toute chaîne
 * de promesses : ni le `try/catch` du `get`, ni le `.catch()` du relevé ne la voient.
 * Le processus meurt. Une ligne d'écoute, et le même échec devient une requête qui
 * expire puis rejette normalement.
 *
 * On avale sans relayer, à dessein : `net-snmp` ne fait passer par cet événement que
 * les datagrammes qu'il n'a pas su lire. Les échecs de requête — délai, communauté
 * refusée, varbind en erreur — arrivent par le callback de la requête et ne sont pas
 * concernés. Un paquet perdu ici laisse simplement la requête aller à son délai, ce qui
 * est la conclusion juste : nous n'avons pas eu de réponse exploitable.
 *
 * Le paquet fautif n'est pas forcément une réponse à nous. Le port éphémère d'une
 * session reçoit ce que le réseau veut bien y envoyer — un firmware bavard, un service
 * tiers qui répond à côté, ou l'une des 254 adresses du balayage qui parle autre chose
 * que du SNMP. D'où la trace : sans elle, un appareil qui émet du charabia en continu
 * ne se manifesterait que par des relevés qui expirent, sans jamais dire pourquoi.
 *
 * (À savoir en lisant `net-snmp` : son `Session.prototype.onError` fait `this.emit(error)`
 * et non `this.emit('error', error)` — l'objet d'erreur y sert de *nom* d'événement. Les
 * erreurs de socket n'atteignent donc jamais cet écouteur. Ce n'est pas notre chemin de
 * plantage, mais ça explique qu'on ne puisse pas compter dessus pour les voir.)
 */
export function guardSession(session: snmp.Session, host: string): snmp.Session {
  session.on('error', (error: unknown) => {
    trace.warn(`snmp:${host}`, 'unreadable datagram ignored', error);
  });
  return session;
}
