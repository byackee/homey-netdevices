/**
 * Le driver « port de switch ».
 *
 * Il ne relève rien : chaque appareil s'interroge lui-même. Ce qui vit ici, c'est ce qui
 * est **commun à tous les appareils du driver** — les écouteurs des cartes de Flow, à
 * enregistrer une seule fois par driver et non une fois par appareil — et le **pairing**,
 * qui est lié au driver depuis lequel il démarre.
 *
 * 🔴 Le pairing d'un switch est le seul du dépôt qui crée **plusieurs appareils**. C'est
 * permis — plusieurs résultats du même driver, chacun avec son propre `data.id`, l'hôte
 * partagé dans `settings` — et c'est la seule forme qui marche : les cartes de Flow
 * d'`onoff` sont générées par appareil, pas par sous-capability, donc vingt-quatre ports
 * sous un seul appareil seraient vingt-quatre boutons sans une seule carte de Flow.
 *
 * Le balayage est au niveau app, comme pour l'onduleur : un seul balayage sert tous les
 * drivers, celui-ci le consomme et **ne filtre pas sur les adresses déjà appairées** —
 * contrairement à l'onduleur. Un switch dont un port est déjà dans Homey est précisément
 * l'adresse sur laquelle on revient pour en ajouter d'autres.
 */

import Homey from 'homey';

import type NetDevicesApp from '../../app.mjs';
import { SnmpClient, negotiateVersion, type SnmpVersion } from '../../lib/snmp/client.mjs';
import { trace } from '../../lib/snmp/trace.mjs';
import { planPortCapabilities } from '../../lib/netswitch/capability-map.mjs';
import { matchesLinkFilter, type LinkChangeSet } from '../../lib/netswitch/link-change.mjs';
import {
  buildPortCandidate,
  disambiguate,
  duplicateIds,
  switchKeyOf,
  type PortCandidate,
} from '../../lib/netswitch/pairing.mjs';
import { NO_THROUGHPUT } from '../../lib/netswitch/throughput.mjs';
import { UNKNOWN_LIVE, type PortSnapshot } from '../../lib/netswitch/port.mjs';
import {
  PORTS_FOR_A_SWITCH,
  looksLikeSwitch,
  readInventory,
  readPortLive,
  readSwitchIdentity,
} from '../../lib/netswitch/reader.mjs';
import type NetSwitchPortDevice from './device.mjs';

/** Une adresse qui a répondu en SNMP, telle que la première liste de la vue l'affiche. */
interface SnmpFinding {
  host: string;
  name: string | null;
  description: string | null;
}

/** Ce que la vue reçoit pendant le balayage. */
interface ScanStatusReply {
  running: boolean;
  done: number;
  total: number;
  subnet: string | null;
  error: string | null;
  /** Tout ce qui parle SNMP. Le tri « est-ce un switch » se fait à l'ouverture, pas ici. */
  devices: SnmpFinding[];
}

/** Une ligne de port, telle que la seconde liste de la vue l'affiche. */
interface PortRow {
  id: string;
  label: string;
  detail: string;
  linkUp: boolean;
  /** Déjà dans Homey : la ligne s'affiche, cochée et désactivée. */
  paired: boolean;
  /** La charge utile de pairing, à passer **telle quelle** à `Homey.createDevice()`. */
  device: PortCandidate['device'];
}

/** La réponse à « ouvre-moi ce switch ». `outcome` est machine, jamais du texte. */
interface PortsReply {
  outcome: 'ok' | 'no-host' | 'silent' | 'no-ports';
  host: string;
  /** Le nom du switch, pour le titre de la seconde liste. */
  name: string | null;
  description: string | null;
  version: SnmpVersion | null;
  /** Vrai quand l'appareil ressemble à un switch ; la vue le dit sans pour autant refuser. */
  looksLikeSwitch: boolean;
  /** Vrai quand des prises PoE ont pu être reliées aux ports. */
  poe: boolean;
  ports: PortRow[];
}

/**
 * Budget d'un `ports` : c'est un appel d'API d'app, coupé à dix secondes.
 *
 * Une demi-douzaine de `walk` sur un switch 48 ports plus un `get` par port tiendraient
 * mal dans ce budget. D'où deux décisions : le premier relevé de chaque port est groupé et
 * **borné en concurrence**, et la version est négociée une seule fois pour tout le lot.
 */
const OPEN_TIMEOUT_MS = 1_800;
/** Premiers relevés menés de front. Chaque sonde tient un socket UDP. */
const OPEN_CONCURRENCY = 8;

export default class NetSwitchDriver extends Homey.Driver {
  override async onInit(): Promise<void> {
    this.registerTriggers();
    this.registerConditions();
    this.registerActions();
  }

  // ---------------------------------------------------------------------------
  // Flow
  // ---------------------------------------------------------------------------

  /** « Le lien passe à X » — le sélecteur filtre, l'appareil ne connaît pas les Flows. */
  private registerTriggers(): void {
    this.homey.flow
      .getDeviceTriggerCard('netswitch_link_changed')
      .registerRunListener(async (args: { state?: string }, state: LinkChangeSet) =>
        matchesLinkFilter(args.state, state.link));
  }

  /**
   * Les conditions numériques rendent **faux** sur une mesure inconnue.
   *
   * C'est le sens de la condition qui l'impose : « le débit dépasse 100 Mbit/s » ne doit
   * pas répondre « oui » parce qu'on n'a pas su lire, ni traiter le `null` comme un zéro.
   */
  private registerConditions(): void {
    this.homey.flow
      .getConditionCard('netswitch_link_is_up')
      .registerRunListener(async (args: { device: NetSwitchPortDevice }) => args.device.isLinkUp());

    this.homey.flow
      .getConditionCard('netswitch_poe_is_delivering')
      .registerRunListener(async (args: { device: NetSwitchPortDevice }) => args.device.isPoeDelivering());

    this.homey.flow
      .getConditionCard('netswitch_speed_above')
      .registerRunListener(async (args: { device: NetSwitchPortDevice; mbps?: number }) => {
        const speed = args.device.measured('speed');
        return speed !== null && speed > Number(args.mbps);
      });
  }

  /**
   * Les actions, dont les deux qui écrivent.
   *
   * 🔴 Elles existent **toujours**, y compris quand `allow_control` est faux : c'est ce qui
   * permet à la carte de refuser avec un message qui dit quoi activer, au lieu de ne pas
   * exister et de laisser l'utilisateur chercher une carte absente. Le refus vient du
   * device, qui interroge `lib/netswitch/control.mts` — jamais d'un test posé ici.
   */
  private registerActions(): void {
    this.homey.flow
      .getActionCard('netswitch_refresh')
      .registerRunListener(async (args: { device: NetSwitchPortDevice }) => {
        await args.device.refreshNow();
      });

    this.homey.flow
      .getActionCard('netswitch_set_port')
      .registerRunListener(async (args: { device: NetSwitchPortDevice; state?: string }) => {
        await args.device.setPortPower(args.state === 'on');
      });

    this.homey.flow
      .getActionCard('netswitch_set_poe')
      .registerRunListener(async (args: { device: NetSwitchPortDevice; state?: string }) => {
        await args.device.setPoePower(args.state === 'on');
      });
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  /** La communauté du balayage en cours, retenue pour que l'ouverture utilise la même. */
  private scanCommunity = 'public';

  /** Une trace visible depuis `GET /trace` : un pairing muet ne se diagnostique pas autrement. */
  private note(message: string, detail?: unknown): void {
    trace.info('pair', message, detail);
    this.log(message);
  }

  /**
   * Conduit la session de pairing.
   *
   * 🔴 **Une seule vue custom**, sans navigation : une vue custom ne peut pas naviguer vers
   * un template système, `showView`/`nextView` échouent en écran blanc ou ferment
   * l'assistant sans rien créer (rétro §8.1, panne 5). La vue bascule donc entre ses deux
   * panneaux dans le même document, et c'est elle qui appelle `Homey.createDevice()`.
   *
   * 🔴 **Requête/réponse, jamais de push.** Tout passe par `Homey.emit()` de la vue vers
   * ces handlers (panne 9).
   *
   * 🔴 **Aucun `session.showView()` depuis un handler** : Homey attend le retour du
   * handler, le handler attendrait la transition, et la session se fige (panne 4).
   */
  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    this.note('onPair start (netswitch)');

    session.setHandler('viewLog', async (message: unknown) => {
      this.note(`vue: ${String(message)}`);
    });

    session.setHandler('scan_start', async (data: unknown): Promise<{
      started: boolean;
      reason?: string;
      subnet: string | null;
      total: number;
    }> => {
      const community = communityOf(data);
      this.scanCommunity = community;
      this.note('scan_start', { communauté: community === 'public' ? 'public' : '(personnalisée)' });

      const app = this.homey.app as NetDevicesApp;
      // 🔴 Aucun `skip` : un switch dont un port est déjà appairé est précisément
      // l'adresse sur laquelle on revient pour en ajouter d'autres.
      const state = await app.startScan(new Set(), community);

      if (state.subnet === null) {
        return { started: false, reason: 'the app could not work out which subnet to sweep', subnet: null, total: 0 };
      }
      return { started: true, subnet: state.subnet, total: state.total };
    });

    session.setHandler('scan_status', async (): Promise<ScanStatusReply> => {
      const app = this.homey.app as NetDevicesApp;
      const state = app.getScanState();

      // `found` et `others` réunis : le balayage partagé trie sur « est-ce un onduleur »,
      // ce qui n'a aucun rapport avec la question posée ici. Un NAS qui relaie un onduleur
      // est aussi une machine à interfaces, et un switch atterrit forcément dans `others`.
      //
      // 🔴 Puis on écarte ce qui ne peut pas être un switch. `ifNumber` est lu pendant le
      // balayage, dans le même paquet que `sysDescr` : c'est ce qui sépare le plus
      // sûrement un switch du reste. Trouvé à l'usage — l'imprimante Epson du réseau,
      // avec son unique interface, était proposée comme switch parce que la seule
      // heuristique qui l'aurait refusée n'intervenait qu'à l'étape suivante.
      //
      // `null` est conservé : un agent qui ne publie pas `ifNumber` n'a pas dit non.
      const devices = [...state.found, ...state.others]
        .filter((finding) => finding.interfaces === null || finding.interfaces >= PORTS_FOR_A_SWITCH)
        .map((finding): SnmpFinding => ({
          host: finding.host,
          name: finding.name,
          description: finding.description,
        }))
        .sort((a, b) => lastOctet(a.host) - lastOctet(b.host));

      return {
        running: state.running,
        done: state.running ? Math.min(state.probed, state.total) : state.total,
        total: state.total,
        subnet: state.subnet,
        error: scanError(state.error, state.subnet),
        devices,
      };
    });

    session.setHandler('ports', async (data: unknown): Promise<PortsReply> => {
      const host = hostOf(data);
      const community = communityOf(data) === 'public' ? this.scanCommunity : communityOf(data);
      // `snmpPort` et non `port` : dans `openSwitch`, `port` désigne déjà un port du
      // switch. Deux notions sans rapport, et les confondre serait un piège permanent.
      const snmpPort = portOf(data);
      this.note(`ports ${host || '(vide)'}`);
      if (host === '') return emptyPorts('no-host', '');

      const reply = await this.openSwitch(host, community, snmpPort);
      this.note(`ports ${host}: ${reply.outcome}, ${reply.ports.length} port(s)`);
      return reply;
    });

    session.setHandler('adopted', async (data: unknown) => {
      this.note('adopted', data);
    });
  }

  /**
   * Ouvre un switch : son identité, ses ports, et le premier relevé de chacun.
   *
   * Le premier relevé n'est pas un luxe : c'est lui qui décide des capabilities de chaque
   * appareil. Un port lu à vide serait appairé sans aucune mesure, et une capability non
   * déclarée au pairing ne s'ajoute qu'au relevé suivant — ou jamais, si le compteur
   * n'existe pas. C'est la même décision que pour l'onduleur, où un snapshot partiel
   * privait l'utilisateur de mesures que l'appareil savait pourtant rendre.
   */
  private async openSwitch(host: string, community: string, snmpPort = 161): Promise<PortsReply> {
    const version = await negotiateVersion(host, community, OPEN_TIMEOUT_MS, snmpPort);
    if (version === null) return emptyPorts('silent', host);

    const client = new SnmpClient({ host, community, version, port: snmpPort, timeout: OPEN_TIMEOUT_MS, retries: 0 });

    const [identity, inventory] = await Promise.all([
      readSwitchIdentity(client),
      readInventory(client),
    ]);

    if (inventory.ports.length === 0) {
      return { ...emptyPorts('no-ports', host), name: identity.name, description: identity.description, version };
    }

    const switchKey = switchKeyOf(identity.serial, identity.name, host);
    const paired = this.pairedIds();

    const snapshots = await this.firstReadings(client, inventory);

    const candidates = inventory.ports.map((port) => {
      const snapshot = snapshots.get(port.ifIndex)!;
      const poe = inventory.poe?.byIfIndex.get(port.ifIndex) ?? null;
      // 🔴 `allowControl: false` — le réglage naît décoché, donc l'appareil naît sans
      // `onoff`. Le lui donner ici le doterait d'une commande que rien n'a autorisée.
      const plan = planPortCapabilities(snapshot, { allowControl: false });
      return buildPortCandidate({
        identity: port,
        switchKey,
        switchName: identity.name,
        host,
        community,
        port: snmpPort,
        version,
        poe,
        capabilities: plan.capabilities,
        values: plan.values,
        linkUp: snapshot.link === 'up',
        speedMbps: snapshot.speedMbps,
      });
    });

    const doubled = duplicateIds(candidates);
    if (doubled.length > 0) {
      // Deux ports du même nom : sans désambiguïsation, l'utilisateur en coche vingt-quatre
      // et en obtient vingt-trois, sans un mot.
      trace.warn('pair', `${host} publie ${doubled.length} nom(s) de port en double`, doubled);
    }

    return {
      outcome: 'ok',
      host,
      name: identity.name,
      description: identity.description,
      version,
      looksLikeSwitch: looksLikeSwitch(inventory),
      poe: inventory.poe !== null,
      ports: disambiguate(candidates).map((candidate): PortRow => ({
        id: candidate.id,
        label: candidate.label,
        detail: candidate.detail,
        linkUp: candidate.linkUp,
        paired: paired.has(candidate.id),
        device: candidate.device,
      })),
    };
  }

  /**
   * Le premier relevé de chaque port, mené par petits paquets.
   *
   * Borné parce que chaque sonde tient un socket UDP et qu'un châssis 48 ports en ouvrirait
   * quarante-huit d'un coup ; borné aussi parce que tout ça vit dans un appel d'API coupé à
   * dix secondes. Un port qui ne répond pas rend un relevé vide plutôt que de faire tomber
   * l'ouverture entière : mieux vaut vingt-trois ports mesurés et un port nu que rien.
   */
  private async firstReadings(
    client: SnmpClient,
    inventory: Awaited<ReturnType<typeof readInventory>>,
  ): Promise<Map<number, PortSnapshot>> {
    const out = new Map<number, PortSnapshot>();
    const queue = [...inventory.ports];

    const worker = async (): Promise<void> => {
      for (;;) {
        const port = queue.shift();
        if (port === undefined) return;
        const poe = inventory.poe?.byIfIndex.get(port.ifIndex) ?? null;

        let live = UNKNOWN_LIVE;
        try {
          live = await readPortLive(client, port.ifIndex, poe);
        } catch (error) {
          trace.warn('pair', `premier relevé sans réponse sur ${client.host} port ${port.ifIndex}`, error);
        }

        out.set(port.ifIndex, {
          ...port,
          speedMbps: inventory.speeds.get(port.ifIndex) ?? null,
          ...live,
          // Aucun débit au premier relevé : il faut deux échantillons pour une différence.
          // C'est bien le **compteur** qui décide de la déclaration, pas le débit.
          ...NO_THROUGHPUT,
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(OPEN_CONCURRENCY, Math.max(1, queue.length)) }, worker));
    return out;
  }

  /** Les identifiants déjà appairés, pour montrer les ports déjà pris sans les réoffrir. */
  private pairedIds(): Set<string> {
    return new Set(this.getDevices().map((device) => String(device.getData().id ?? '')));
  }
}

/** Une réponse d'ouverture sans ports, avec le verdict machine. */
function emptyPorts(outcome: PortsReply['outcome'], host: string): PortsReply {
  return {
    outcome,
    host,
    name: null,
    description: null,
    version: null,
    looksLikeSwitch: false,
    poe: false,
    ports: [],
  };
}

/** L'adresse saisie dans la vue, nettoyée. */
function hostOf(data: unknown): string {
  const body = (data ?? {}) as { host?: unknown };
  return String(body.host ?? '').trim();
}

/** La communauté saisie ; « public » quand elle est vide, jamais une chaîne vide. */
/**
 * Le port UDP demandé, 161 par défaut.
 *
 * Un agent peut écouter ailleurs : un `snmpd` sans privilèges ne peut pas prendre un
 * port sous 1024, pas plus qu'un conteneur sans capacité réseau. Hors bornes ou
 * illisible, on retombe sur 161 plutôt que d'échouer.
 */
function portOf(data: unknown): number {
  const body = (data ?? {}) as { port?: unknown };
  const port = Number(body.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 161;
}

function communityOf(data: unknown): string {
  const body = (data ?? {}) as { community?: unknown };
  return String(body.community ?? 'public').trim() || 'public';
}

/** Trie les adresses d'un /24 dans l'ordre où l'utilisateur les lit. */
function lastOctet(host: string): number {
  return Number(host.split('.')[3] ?? 0);
}

/** L'erreur de balayage, dite en une phrase que la vue peut afficher telle quelle. */
function scanError(error: string | null, subnet: string | null): string | null {
  if (error === null) return null;
  if (error === 'unknown-subnet') return 'the app could not work out which subnet to sweep';
  return subnet === null ? error : `${subnet}.0/24: ${error}`;
}
