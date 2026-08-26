/**
 * Enveloppe promise minimale au-dessus de `net-snmp`, taillée pour ce que les
 * appareils réseau font vraiment.
 *
 * `net-snmp` est du JavaScript pur au-dessus de `dgram` : il tourne sur Homey sans
 * étape de compilation native. Tout ici est délibérément tolérant — un appareil
 * endormi, éteint, ou simplement dépourvu d'un OID optionnel doit dégrader en
 * « inconnu » plutôt que faire tomber le relevé entier.
 *
 * Recopié de `homey-netprinter/lib/snmp-client.mts`, dont le comportement a été
 * éprouvé sur du vrai matériel. Deux seules différences, toutes deux additives :
 * les commentaires ne parlent plus d'imprimantes, et `host` devient public pour
 * que les sondes de `scan.mts` puissent nommer l'appareil qu'elles viennent
 * d'identifier.
 */

// Import de namespace : `net-snmp` est du CommonJS et ne publie pas d'export par défaut.
import * as snmp from 'net-snmp';
import { guardSession } from './session-guard.mjs';

/** Versions SNMP proposées. v3 est hors périmètre : aucune de nos cibles ne l'impose. */
export type SnmpVersion = 'v2c' | 'v1';

export interface SnmpOptions {
  host: string;
  community: string;
  version: SnmpVersion;
  /** Délai par tentative, en millisecondes. */
  timeout?: number;
  /** Réessais *après* la première tentative. */
  retries?: number;
  port?: number;
  /**
   * Budget total d'un `get`, en millisecondes. `undefined` = aucun plafond.
   *
   * 🔴 Nécessaire à cause du chemin v1, où `get` se démultiplie en un paquet par OID.
   * Sept OID à 2,5 s avec un réessai font trente-cinq secondes, alors qu'un appel à
   * l'API d'une app est coupé à dix. Le commentaire d'origine comptait des *appels*
   * là où v1 compte des *paquets* — mesuré à 12,4 s sur le chemin de sonde complet.
   *
   * Passé le budget, les OID restants valent `null` : « on n'a pas eu le temps de
   * demander » et « l'appareil ne l'a pas » se ressemblent côté lecteur, et c'est
   * acceptable pour une lecture partielle — contrairement à un appel qui n'aboutit
   * jamais, où l'utilisateur ne voit qu'un timeout sans explication.
   */
  budgetMs?: number;
}

/** Combien de paquets v1 partent de front. Assez pour tenir le budget, assez peu pour
 * ne pas noyer un agent embarqué — une carte d'onduleur n'est pas un serveur. */
const V1_CONCURRENCY = 6;

/** Une valeur lue sur l'appareil, déjà sortie de la forme Buffer de net-snmp. */
export type SnmpValue = string | number | Buffer | null;

/**
 * Ce qu'une sonde a besoin de savoir faire, et rien de plus.
 *
 * `SnmpClient` l'implémente. L'interface existe pour que `scan.mts` reste
 * testable sans ouvrir un socket UDP : une classe à champs privés n'est pas
 * substituable structurellement, une interface l'est.
 */
export interface SnmpReader {
  readonly host: string;
  get(oids: string[], keepRaw?: boolean): Promise<Map<string, SnmpValue>>;
  walk(rootOid: string, maxRepetitions?: number): Promise<Map<string, SnmpValue>>;
}

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_PORT = 161;

/**
 * Plafond de feuilles d'un seul parcours. Large devant tout ce que ces MIB peuvent
 * rendre — la table de stockage d'un NAS bien fourni tient dans quelques centaines
 * de lignes — et c'est bien pour cela qu'il est un filet, pas une limite de travail.
 */
const WALK_MAX_VARBINDS = 10_000;

/**
 * Compare deux OID **composant par composant**, et non comme du texte : en ordre
 * lexical de chaînes, `1.3.6.1.2.1.25.2.3.1.10` précède `1.3.6.1.2.1.25.2.3.1.2`,
 * et le contrôle de progression déclarerait à tort une boucle sur toute table
 * dépassant neuf colonnes.
 */
function compareOids(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const delta = Number(a[i]) - Number(b[i]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * net-snmp rend les chaînes sous forme de Buffer ; seul l'appelant sait ce qu'il veut.
 * `type` et `value` sont tous deux optionnels dans les typages publiés, et un vrai
 * agent peut omettre l'un ou l'autre : aucun des deux n'est présumé ici.
 *
 * 🔴 Un `Opaque` ressort en **Buffer brut**, jamais converti : le décodage du flottant
 * propriétaire Net-SNMP appartient au lecteur (`opaque.mjs`), pas au transport. C'est
 * ce qui garde un OID absent à `null` au lieu d'un zéro inventé.
 */
function toValue(varbind: snmp.Varbind): SnmpValue {
  const value = varbind.value;
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
    // OctetString est le seul type Buffer qui porte du texte lisible.
    // Latin-1 évite de lever sur les octets hauts que certains firmwares émettent.
    if (varbind.type === snmp.ObjectType.OctetString) return value.toString('latin1').trim();
    if (varbind.type === snmp.ObjectType.Counter64) return fromCounter64(value);
    return value;
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Un Counter64 arrive en **huit octets bruts**, pas en nombre.
 *
 * 🔴 `net-snmp` rend `ObjectType.Counter64` sous forme de Buffer (`readUint64`), et rien
 * en aval ne le convertissait : `toNumber` ne reconnaît que l'`Opaque Float` propriétaire
 * — sept ou onze octets — et rendait `null` sur les huit d'un compteur. `ifHCInOctets` et
 * `ifHCOutOctets` étaient donc **nuls sur tout switch réel**, et les capabilities de débit
 * ne pouvaient jamais se déclarer. Le `typeof value === 'bigint'` juste au-dessus visait ce
 * cas ; il ne l'atteignait pas, parce que la bibliothèque ne rend pas un bigint.
 *
 * La conversion vers `number` perd la précision au-delà de 2^53 octets — soit, à 10 Gbit/s
 * saturés en permanence, deux cent mille ans. Le calcul de débit travaille sur des écarts,
 * et un compteur qui recule est déjà traité comme un redémarrage d'agent.
 */
function fromCounter64(bytes: Buffer): number | null {
  if (bytes.length !== 8) return null;
  return Number(bytes.readBigUInt64BE(0));
}

/** Comme {@link toValue}, mais garde les OctetString en octets bruts, pour les chaînes de bits. */
function toRaw(varbind: snmp.Varbind): Buffer | null {
  return Buffer.isBuffer(varbind.value) ? varbind.value : null;
}

/**
 * Levée quand l'appareil n'a pas pu être joint du tout — par opposition à « je ne sais pas ».
 *
 * `garbled` porte le dernier datagramme illisible reçu **pendant cette opération**, quand
 * il y en a eu un. Sans lui, un appareil qui répond du charabia est indiscernable d'un
 * appareil absent : le message dit « aucune réponse », l'utilisateur va vérifier son
 * adresse et sa communauté, et il cherche là où il n'y a rien.
 */
export class SnmpUnreachableError extends Error {
  constructor(host: string, cause: string, garbled: string | null = null) {
    super(garbled === null
      ? `No SNMP answer from ${host}: ${cause}`
      : `No SNMP answer from ${host}: ${cause} (an unreadable reply also arrived: ${garbled})`);
    this.name = 'SnmpUnreachableError';
  }
}

/**
 * Une conversation SNMP avec un appareil.
 *
 * Une session possède un socket UDP, elle doit donc être fermée. Les sessions sont
 * bon marché ; cette classe en ouvre une **par opération** plutôt que d'en tenir une
 * sur toute la période de relevé, parce qu'un socket à longue vie ne survit ni au
 * redémarrage de l'app Homey ni au changement d'adresse de l'appareil.
 */
export class SnmpClient implements SnmpReader {
  /** Public : une sonde reçoit un client et doit pouvoir nommer l'adresse interrogée. */
  readonly host: string;
  private readonly community: string;
  private readonly version: SnmpVersion;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly port: number;
  /** Plafond de temps d'un `get`, décisif sur le chemin v1. `undefined` = aucun. */
  private readonly budgetMs: number | undefined;

  /**
   * Le dernier datagramme illisible reçu, ou `null`.
   *
   * 🔴 Remis à `null` au début de **chaque** opération, et c'est la seule façon honnête de
   * s'en servir. Le garder d'une opération à l'autre reviendrait à coller un incident
   * d'il y a dix minutes sur un délai dépassé qui n'a rien à voir — un faux indice, ce qui
   * est pire qu'aucun. Ce champ ne prétend donc qu'à une chose : « pendant que cette
   * requête-ci attendait, ceci est arrivé sur le socket ».
   */
  private garbled: string | null = null;

  constructor(options: SnmpOptions) {
    this.host = options.host;
    this.community = options.community;
    this.version = options.version;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.budgetMs = options.budgetMs;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.port = options.port ?? DEFAULT_PORT;
  }

  /**
   * @param timeoutMs plafonne le délai de cette requête-ci, sous le délai configuré.
   *   Sert au budget v1 : sans lui, le budget empêche seulement de *démarrer* une
   *   requête après l'échéance, et celle qui est déjà en vol la dépasse librement.
   */
  private openSession(timeoutMs?: number): snmp.Session {
    // `guardSession` n'est pas décoratif : sans son écouteur `'error'`, un seul paquet
    // UDP illisible arrivant sur ce socket tue le processus de l'app. Voir son en-tête.
    return guardSession(snmp.createSession(this.host, this.community, {
      version: this.version === 'v1' ? snmp.Version1 : snmp.Version2c,
      timeout: timeoutMs === undefined ? this.timeout : Math.max(1, Math.min(this.timeout, timeoutMs)),
      retries: this.retries,
      port: this.port,
    }), this.host, (message) => { this.garbled = message; });
  }

  /**
   * Lit plusieurs OID d'un coup, chacun rendu vers sa valeur ou vers null.
   *
   * Tout l'intérêt de préférer v2c est ici. En v1, un seul OID non supporté fait
   * échouer la requête *entière* avec NoSuchName — un compteur manquant coûterait
   * aussi la charge de la batterie. v2c rapporte l'échec par varbind ; cette méthode
   * retombe donc sur une requête par OID quand elle parle v1.
   *
   * (Annexe A, piège 7 : v1 perd aussi silencieusement les Counter64. v2c reste le défaut.)
   */
  async get(oids: string[], keepRaw = false): Promise<Map<string, SnmpValue>> {
    if (oids.length === 0) return new Map();
    this.garbled = null;
    if (this.version === 'v1') return this.getOneByOne(oids, keepRaw);

    const session = this.openSession();
    try {
      const varbinds = await new Promise<snmp.Varbind[]>((resolve, reject) => {
        session.get(oids, (error, result) => {
          if (error) reject(error);
          else resolve(result ?? []);
        });
      });

      const out = new Map<string, SnmpValue>();
      oids.forEach((oid, index) => {
        const vb = varbinds[index];
        // NoSuchObject / NoSuchInstance / EndOfMibView veulent tous dire « cet appareil
        // ne l'a pas », ce qui est un null, pas un échec.
        if (!vb || snmp.isVarbindError(vb)) out.set(oid, null);
        else out.set(oid, keepRaw ? toRaw(vb) : toValue(vb));
      });
      return out;
    } catch (error) {
      throw new SnmpUnreachableError(this.host, (error as Error).message, this.garbled);
    } finally {
      session.close();
    }
  }

  /**
   * Le chemin v1 : isoler chaque OID pour qu'une feuille non supportée n'empoisonne pas
   * le reste — au prix d'un paquet par OID, que v2c fait tenir dans un seul.
   *
   * Les paquets partent par lots plutôt qu'un par un, et le budget arrête les frais :
   * séquentiel et sans plafond, sept OID dépassaient largement les dix secondes d'un
   * appel d'API d'app.
   */
  private async getOneByOne(oids: string[], keepRaw: boolean): Promise<Map<string, SnmpValue>> {
    const out = new Map<string, SnmpValue>();
    let reachable = false;
    let lastError = 'no answer';
    const deadline = this.budgetMs === undefined ? Infinity : Date.now() + this.budgetMs;

    const askOne = async (oid: string): Promise<void> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Non demandé faute de temps. `null` est la seule réponse honnête.
        out.set(oid, null);
        return;
      }
      // Le délai de CE paquet est borné par ce qui reste du budget : un réessai qui
      // déborderait l'échéance ne sert personne, l'appel d'API sera déjà coupé.
      const attempts = this.retries + 1;
      const session = this.openSession(
        deadline === Infinity ? undefined : Math.floor(remaining / attempts),
      );
      try {
        const varbinds = await new Promise<snmp.Varbind[]>((resolve, reject) => {
          session.get([oid], (error, result) => {
            if (error) reject(error);
            else resolve(result ?? []);
          });
        });
        reachable = true;
        const vb = varbinds[0];
        out.set(oid, !vb || snmp.isVarbindError(vb) ? null : (keepRaw ? toRaw(vb) : toValue(vb)));
      } catch (error) {
        const message = (error as Error).message;
        // NoSuchName est la façon v1 de dire que l'OID est absent — c'est un null.
        // Un timeout est d'une autre nature et ne doit pas ressembler à
        // « supporté mais vide ».
        if (/NoSuchName/i.test(message)) reachable = true;
        else lastError = message;
        out.set(oid, null);
      } finally {
        session.close();
      }
    };

    for (let i = 0; i < oids.length; i += V1_CONCURRENCY) {
      await Promise.all(oids.slice(i, i + V1_CONCURRENCY).map(askOne));
    }

    // Un budget épuisé n'est pas une injoignabilité : si une seule feuille a répondu,
    // l'appareil est là et la lecture est simplement partielle.
    if (!reachable) throw new SnmpUnreachableError(this.host, lastError, this.garbled);
    return out;
  }

  /**
   * Parcourt un sous-arbre et rend toutes les feuilles en dessous.
   *
   * C'est ce qu'il faut pour les tables dont le nombre de lignes est précisément ce
   * qu'on ne doit pas coder en dur : un onduleur monophasé et un triphasé ressortent
   * tous deux corrects parce que ni le compte ni les index ne sont présumés.
   *
   * 🔴 Le parcours s'arrête de lui-même, il ne fait pas confiance à l'agent d'en face.
   * `net-snmp` ne conclut que sur `EndOfMibView` (index.js, `walkCb`) : un agent qui
   * répond `noSuchObject` **sur l'OID demandé** — ce que font les agents dont le
   * sous-arbre interrogé est simplement absent — laisse `oidInSubtree` vrai, et le
   * `getNext` suivant repart du même point. Boucle infinie, sans erreur et sans délai
   * d'attente : mesuré à 1,7 million de varbinds en quinze secondes sur un hôte qui
   * ne publie pas ENTITY-SENSOR-MIB. Trois garde-fous ferment ce trou, et le premier
   * suffit dans tous les cas observés :
   *
   * 1. **la progression de l'OID** — RFC 3416 §4.2.2 exige que chaque `getNext` rende
   *    un OID strictement supérieur ; celui qui ne progresse pas termine le parcours ;
   * 2. **le type de varbind** — `noSuchObject` / `noSuchInstance` sous la racine veut
   *    dire « il n'y a rien ici », donc fin, pas « continue » ;
   * 3. **un plafond de feuilles**, filet de sécurité contre un agent qui progresserait
   *    tout en ne s'arrêtant jamais.
   *
   * Un parcours écourté **rend ce qu'il a lu** au lieu de lever : côté lecteurs, une
   * ligne absente vaut déjà `null`, et c'est le même verdict qu'un sous-arbre vide.
   */
  async walk(rootOid: string, maxRepetitions = 20): Promise<Map<string, SnmpValue>> {
    this.garbled = null;
    const session = this.openSession();
    const out = new Map<string, SnmpValue>();
    let previousOid: string | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        session.subtree(
          rootOid,
          maxRepetitions,
          // Rendre `true` arrête le parcours : c'est le seul levier que `subtree`
          // laisse à l'appelant, et il conclut par le rappel de fin sans erreur.
          (varbinds: snmp.Varbind[]): boolean => {
            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) return true;
              if (previousOid !== null && compareOids(vb.oid, previousOid) <= 0) return true;
              previousOid = vb.oid;
              out.set(vb.oid, toValue(vb));
              if (out.size >= WALK_MAX_VARBINDS) return true;
            }
            return false;
          },
          (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
      return out;
    } catch (error) {
      throw new SnmpUnreachableError(this.host, (error as Error).message, this.garbled);
    } finally {
      session.close();
    }
  }
}

/**
 * Trouve une version sur laquelle l'appareil répond, en préférant v2c pour son
 * rapport d'erreur par varbind. Rend null quand aucune des deux n'obtient de
 * réponse, ce que le pairing montre à l'utilisateur comme « injoignable ».
 */
export async function negotiateVersion(
  host: string,
  community: string,
  timeout = 4_000,
  port = 161,
): Promise<SnmpVersion | null> {
  const probe = '1.3.6.1.2.1.1.1.0'; // sysDescr.0 — tout agent SNMP le possède.

  for (const version of ['v2c', 'v1'] as const) {
    const client = new SnmpClient({ host, community, version, port, timeout, retries: 0 });
    try {
      const result = await client.get([probe]);
      if (result.get(probe) !== null) return version;
    } catch {
      // On essaie la version suivante ; l'appelant ne veut savoir que si l'une a marché.
    }
  }
  return null;
}
