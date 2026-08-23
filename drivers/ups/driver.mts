/**
 * Le driver onduleur.
 *
 * Il ne relève rien : chaque appareil s'interroge lui-même (plan §4.2). Ce qui vit ici,
 * c'est ce qui est **commun à tous les appareils du driver** — les écouteurs des cartes
 * Flow, qu'il faut enregistrer une seule fois par driver et non une fois par appareil.
 *
 * Et le **pairing**, qui vit ici pour une raison de fond : une session de pairing est liée
 * au driver depuis lequel elle démarre (plan §3.7). Le balayage, lui, est au niveau app —
 * un seul balayage sert tous les drivers, et celui-ci le consomme en le filtrant sur sa
 * propre classe.
 */

import Homey from 'homey';

import type NetDevicesApp from '../../app.mjs';
import type { AddressProbe, ScanFinding } from '../../app.mjs';
import type { SnmpVersion } from '../../lib/snmp/client.mjs';
import { vendorForMac } from '../../lib/snmp/oui.mjs';
import { trace } from '../../lib/snmp/trace.mjs';
import type { UpsSource } from '../../lib/ups/snapshot.mjs';
import {
  buildCandidate,
  communityOf,
  portOf,
  dedupeByHost,
  hostOf,
  type PairingDevice,
} from './pairing.mjs';
import { UpsChangeDetector, matchesStatusFilter, type UpsChangeSet } from './poll-engine.mjs';
import type UpsDevice from './device.mjs';

/**
 * Une ligne, telle que la vue de pairing la lit.
 *
 * 🔴 Forme **plate**, et c'est un contrat : `drivers/ups/pair/start.html` lit `host`,
 * `name`, `model`, `manufacturer`, `serial`, `source`, `version` et `description`
 * directement sur cet objet. Un champ renommé ici ne casse rien de visible — la vue
 * affiche simplement une ligne vide, ou une liste vide, sans une erreur.
 */
interface Finding {
  host: string;
  /** `sysName` : le nom que l'appareil se donne, et donc celui que l'utilisateur reconnaît. */
  name: string | null;
  model: string | null;
  manufacturer: string | null;
  serial: string | null;
  /** Le dialecte reconnu ; `null` pour une adresse qui parle SNMP sans être un onduleur. */
  source: UpsSource | null;
  /** La version sur laquelle l'appareil a effectivement répondu. */
  version: SnmpVersion;
  description: string | null;
  /** La marque déduite du préfixe OUI, quand la découverte a vu passer la MAC. */
  vendor: string | null;
  /**
   * La charge utile de pairing, assemblée par `pairing.mts`.
   *
   * Présente uniquement sur un onduleur. C'est la seule forme dont les clés admises sont
   * vérifiées par le compilateur **et** par un test (`test/drivers/pairing.test.mts`) ;
   * une vue qui l'adopte telle quelle ne peut pas vider la liste avec une clé en trop.
   */
  device?: PairingDevice;
}

/** Ce que la vue reçoit à chaque interrogation, pendant et après le balayage. */
interface ScanStatusReply {
  running: boolean;
  /** Avancement : une barre qui bouge, parce qu'un écran figé de seize secondes se lit comme cassé. */
  done: number;
  total: number;
  subnet: string | null;
  error: string | null;
  found: Finding[];
  /** Répondent en SNMP sans être des onduleurs : un diagnostic, pas du bruit. */
  others: Finding[];
  /**
   * 🔴 Adresses présentes sur le réseau et muettes en SNMP.
   *
   * Ce sont les MAC de constructeurs d'onduleurs vues par la découverte : l'appareil est
   * là, prouvé par l'ARP, et il ne répond pas. C'est le symptôme exact d'un SNMP éteint —
   * celui qui laisse le fil APC du forum Homey en échec depuis 2018.
   */
  reachable: string[];
}

/**
 * Le verdict sur une adresse saisie à la main.
 *
 * `outcome` est **machine**, jamais du texte : la formulation appartient à la vue, qui
 * seule connaît la langue de l'utilisateur. Le driver dit ce qui s'est passé.
 */
interface ProbeReply extends Finding {
  /** `ups` | `snmp` | `reachable` | `silent` | `no-host` | `already-paired`. */
  outcome: string;
}

/** Ce que la vue de réparation reçoit. */
interface RepairReply {
  ok: boolean;
  /** Pourquoi ça n'a pas marché, quand ce n'est pas un cas d'identité. */
  message?: string;
  /** Le numéro de série trouvé à cette adresse, quand ce n'est pas le bon appareil. */
  found?: string;
  /** Celui qu'on attendait. */
  expected?: string;
}

export default class UpsDriver extends Homey.Driver {
  override async onInit(): Promise<void> {
    this.registerStatusTrigger();
    this.registerRuntimeTrigger();
    this.registerConditions();
    this.registerActions();
  }

  /** « L'état passe à X » — le sélecteur filtre, l'appareil ne connaît pas les Flows. */
  private registerStatusTrigger(): void {
    this.homey.flow
      .getDeviceTriggerCard('ups_status_changed')
      .registerRunListener(async (args: { status?: string }, state: UpsChangeSet) =>
        matchesStatusFilter(args.status, state.status));
  }

  /**
   * « L'autonomie descend sous X minutes ».
   *
   * Le franchissement se juge **ici**, à partir des deux bornes portées par l'état de
   * l'événement, parce que le seuil appartient à chaque Flow : deux Flows réglés à 15 et
   * à 5 minutes doivent tous deux partir au bon moment sur un seul relevé SNMP. Un
   * franchissement, pas un état : rester quinze minutes sous le seuil ne redéclenche rien.
   */
  private registerRuntimeTrigger(): void {
    this.homey.flow
      .getDeviceTriggerCard('ups_runtime_below')
      .registerRunListener(async (args: { minutes?: number }, state: UpsChangeSet) => {
        const threshold = Number(args.minutes);
        if (!Number.isFinite(threshold)) return false;
        return UpsChangeDetector.crossedBelow(state, threshold);
      });
  }

  /**
   * Les conditions numériques rendent **faux** sur une mesure inconnue.
   *
   * C'est le sens de la condition qui l'impose : « l'autonomie est supérieure à 10 min »
   * doit protéger un arrêt propre. Répondre « oui » parce qu'on n'a pas su lire, ou
   * traiter le `null` comme un 0, revient dans les deux cas à décider à l'aveugle.
   */
  private registerConditions(): void {
    this.homey.flow
      .getConditionCard('ups_is_on_battery')
      .registerRunListener(async (args: { device: UpsDevice }) => args.device.isOnBattery());

    this.homey.flow
      .getConditionCard('ups_runtime_above')
      .registerRunListener(async (args: { device: UpsDevice; minutes?: number }) => {
        const runtime = args.device.measured('runtime');
        return runtime !== null && runtime > Number(args.minutes);
      });

    this.homey.flow
      .getConditionCard('ups_battery_above')
      .registerRunListener(async (args: { device: UpsDevice; percent?: number }) => {
        const charge = args.device.measured('battery');
        return charge !== null && charge > Number(args.percent);
      });
  }

  /**
   * La seule action de la v1, et elle est en lecture.
   *
   * 🔴 Pas de « lancer un test de batterie », pas d'« éteindre » : `upsControl` de la
   * RFC 1628 couperait l'alimentation de tout ce qui est branché sur l'onduleur, et
   * `upsTestDeepBatteryCalibration` use la batterie à chaque exécution (plan §3.6).
   */
  private registerActions(): void {
    this.homey.flow
      .getActionCard('ups_refresh')
      .registerRunListener(async (args: { device: UpsDevice }) => {
        await args.device.refreshNow();
      });
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  /**
   * Les onduleurs repérés par la stratégie de découverte, déjà sondés en SNMP.
   *
   * Retenus entre deux interrogations parce que la découverte MAC répond en une seconde
   * là où le balayage en prend seize : ce sont les candidats que la vue peut offrir avant
   * même que la barre ait bougé.
   */
  private discovered: Finding[] = [];
  /**
   * La communauté du balayage en cours.
   *
   * `fromScan()` écrivait `'public'` en dur, si bien qu'un utilisateur ayant changé sa
   * communauté SNMP — précisément celui à qui ce détail importe — voyait son onduleur
   * adopté avec la mauvaise, sans un mot : soit son réglage n'avait servi à rien, soit
   * l'appareil devenait injoignable dès le premier relevé.
   */
  private scanCommunity = 'public';

  /** Les adresses annoncées par la découverte qui ne répondent pas en SNMP. */
  private silent: string[] = [];

  /** Une trace visible depuis `GET /trace` : un pairing muet ne se diagnostique pas autrement. */
  private note(message: string, detail?: unknown): void {
    trace.info('pair', message, detail);
    this.log(message);
  }

  /**
   * Conduit la session de pairing.
   *
   * 🔴 **Une seule vue custom**, sans navigation. Une vue custom ne peut pas naviguer vers
   * un template système : `showView`/`nextView` échouent dans le frontend de pairing et
   * laissent un écran blanc, ou ferment l'assistant sans rien créer (rétro §8.1, panne 5).
   * La vue appelle donc `Homey.createDevice()` elle-même et ne passe jamais la main à
   * `list_devices`.
   *
   * 🔴 **Requête/réponse, jamais de push.** Tout passe par `Homey.emit()` de la vue vers
   * ces handlers, et la vue interroge. `session.emit()` dans l'autre sens n'a jamais été
   * vérifié ici, et quand la vue n'affiche rien il devient impossible de distinguer « le
   * balayage a échoué » de « les événements ne sont jamais arrivés » (panne 9).
   *
   * 🔴 **Aucun `session.showView()` depuis un handler** : Homey attend le retour du
   * handler, le handler attendrait la transition, et la session se fige (panne 4).
   */
  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    this.note('onPair start');
    this.discovered = [];
    this.silent = [];

    // Sans ça, une erreur de script dans la vue est totalement invisible : une app
    // installée par CLI n'a aucun log lisible, et l'écran ne dit rien.
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
      // Retenue pour toute la durée du balayage : `fromScan()` en a besoin pour que
      // l'appareil adopté soit interrogé avec la communauté réellement saisie.
      this.scanCommunity = community;
      this.note('scan_start', { communauté: community === 'public' ? 'public' : '(personnalisée)' });

      const app = this.homey.app as NetDevicesApp;
      const state = await app.startScan(this.pairedHosts(), community);

      // Lancée, pas attendue : sonder les adresses annoncées prend le temps qu'il faut,
      // et la vue doit pouvoir afficher sa barre pendant ce temps-là.
      void this.probeAnnounced(community);

      this.note(`balayage running=${state.running} subnet=${state.subnet ?? 'inconnu'}`);
      if (state.subnet === null) {
        return {
          started: false,
          reason: 'the app could not work out which subnet to sweep',
          subnet: null,
          total: 0,
        };
      }
      return { started: true, subnet: state.subnet, total: state.total };
    });

    session.setHandler('scan_status', async (): Promise<ScanStatusReply> => {
      const app = this.homey.app as NetDevicesApp;
      const state = app.getScanState();
      const taken = this.pairedHosts();
      const ids = this.pairedIds();

      // La découverte d'abord : elle connaît la marque par l'OUI, donc elle nomme mieux
      // le même appareil que le balayage trouvera une seconde plus tard.
      const found = dedupeByHost([...this.discovered, ...state.found.map((f) => this.fromScan(f, this.scanCommunity))])
        .filter((finding) => !taken.has(finding.host))
        .filter((finding) => finding.device === undefined || !ids.has(finding.device.data.id));

      if (!state.running) {
        this.note(`balayage terminé : ${found.length} onduleur(s), ${state.others.length} autre(s) en SNMP, ${this.silent.length} muet(s)`);
      }

      return {
        running: state.running,
        done: state.running ? Math.min(state.probed, state.total) : state.total,
        total: state.total,
        subnet: state.subnet,
        error: scanError(state.error, state.subnet),
        found,
        others: state.others.map((f) => this.fromScan(f, this.scanCommunity)),
        reachable: [...this.silent],
      };
    });

    session.setHandler('probe', async (data: unknown): Promise<ProbeReply> => {
      const host = hostOf(data);
      const community = communityOf(data);
      this.note(`probe ${host || '(vide)'}`);

      if (host === '') return { ...emptyFinding(''), outcome: 'no-host' };
      if (this.pairedHosts().has(host)) return { ...emptyFinding(host), outcome: 'already-paired' };

      const app = this.homey.app as NetDevicesApp;
      const port = portOf(data);
      const probe = await app.probeAddress(host, community, port);
      const finding = this.fromProbe(probe, community, port, null, null);

      this.note(`probe ${host}: ${probe.outcome}`, finding.device?.name);
      return { ...finding, outcome: probe.outcome };
    });

    // Ce que la vue a réellement créé. Sans cette ligne, un `createDevice()` qui échoue
    // côté Homey ne laisse aucune trace du côté de l'app.
    session.setHandler('adopted', async (data: unknown) => {
      this.note('adopted', data);
    });
  }

  /**
   * La réparation, qui existe pour une panne précise : l'onduleur a changé d'adresse.
   *
   * 🔴 Elle vérifie que c'est **le même appareil** avant d'écrire quoi que ce soit.
   * L'appariement se fait sur l'identité SNMP, jamais sur l'adresse (plan §3.5) : pointer
   * une réparation sur la machine voisine ne lève rien, ne se voit jamais, et l'appareil
   * continue de relever — simplement plus le bon onduleur.
   */
  override async onRepair(session: Homey.Driver.PairSession, device: Homey.Device): Promise<void> {
    this.note(`onRepair start: ${device.getName()}`);

    session.setHandler('viewLog', async (message: unknown) => {
      this.note(`vue (repair): ${String(message)}`);
    });

    session.setHandler('getConfig', async (): Promise<{ host: string; community: string }> => ({
      host: String(device.getSetting('host') ?? ''),
      community: String(device.getSetting('community') ?? 'public'),
    }));

    session.setHandler('setAddress', async (data: unknown): Promise<RepairReply> => {
      const host = hostOf(data);
      const community = communityOf(data);
      this.note(`setAddress ${host || '(vide)'}`);

      if (host === '') return { ok: false, message: 'no address given' };

      const app = this.homey.app as NetDevicesApp;
      const probe = await app.probeAddress(host, community);

      if (probe.outcome !== 'ups' || probe.version === null) {
        this.note(`setAddress ${host}: ${probe.outcome}`);
        return { ok: false, message: repairMessage(probe.outcome, host) };
      }

      const expected = storedSerial(device);
      const found = probe.identity?.serial ?? null;

      // Deux numéros de série connus qui diffèrent : c'est un autre onduleur. On n'écrit
      // rien et on le dit, plutôt que de faire pointer l'appareil sur le voisin.
      if (expected !== null && found !== null && expected !== found) {
        this.note(`setAddress ${host}: série ${found} ≠ ${expected}, réglages inchangés`);
        return { ok: false, found, expected };
      }

      await device.setSettings({ host, community, version: probe.version });
      // Le numéro de série est mémorisé au passage : un appareil appairé avant que la
      // vérification existe n'en portait pas, et sans ça il n'en porterait jamais.
      if (found !== null) {
        await device.setStoreValue('serial', found).catch((error: Error) =>
          this.error(`Impossible de mémoriser le numéro de série : ${error.message}`));
      }
      this.note(`setAddress ${host}: réglages réécrits (série ${found ?? 'inconnue'})`);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Ce que le pairing offre
  // ---------------------------------------------------------------------------

  /** Les adresses déjà appairées, pour n'offrir que du nouveau. */
  private pairedHosts(): Set<string> {
    return new Set(
      this.getDevices()
        .map((device) => String(device.getSetting('host') ?? ''))
        .filter((host) => host !== ''),
    );
  }

  /**
   * Les identités déjà appairées.
   *
   * Le filtre par adresse ne suffit pas : un onduleur qui vient de changer d'IP serait
   * offert une seconde fois, et l'utilisateur se retrouverait avec deux appareils pour un
   * seul onduleur — dont un définitivement muet.
   */
  private pairedIds(): Set<string> {
    return new Set(this.getDevices().map((device) => String(device.getData().id ?? '')));
  }

  /**
   * Les adresses que la stratégie de découverte a vues, avec leur marque.
   *
   * La stratégie `mac` résout des préfixes OUI par ARP : elle donne une adresse et une
   * MAC, jamais un modèle. Chaque adresse est donc **sondée en SNMP** avant d'être
   * offerte — une MAC d'un constructeur d'onduleur ne prouve pas qu'il y a un agent en
   * face, et proposer un appareil illisible ne ferait que repousser la déception.
   */
  private announcedAddresses(): { address: string; mac: string; vendor: string | null }[] {
    try {
      const results = this.getDiscoveryStrategy().getDiscoveryResults();
      return Object.values(results)
        .map((result) => {
          const found = result as Homey.DiscoveryResultMAC;
          const mac = String(found.mac ?? '');
          return { address: String(found.address ?? ''), mac, vendor: vendorForMac(mac) };
        })
        .filter((entry) => entry.address !== '');
    } catch (error) {
      // Une stratégie absente ou pas encore prête ne doit pas faire tomber le pairing :
      // le balayage trouve les mêmes appareils, juste plus lentement.
      trace.warn('pair', 'découverte illisible', error);
      return [];
    }
  }

  /**
   * Sonde en SNMP ce que la découverte a annoncé.
   *
   * Deux résultats valent d'être gardés, et le second autant que le premier : un onduleur
   * lisible, et une **adresse prouvée présente qui ne répond pas**. La seconde est ce qui
   * permet de dire « votre onduleur est là, allez activer SNMP » au lieu de « aucun
   * appareil trouvé ».
   */
  private async probeAnnounced(community: string): Promise<void> {
    const app = this.homey.app as NetDevicesApp;
    const taken = this.pairedHosts();
    const announced = this.announcedAddresses().filter((entry) => !taken.has(entry.address));

    this.note(`découverte : ${announced.length} adresse(s) annoncée(s)`);

    // Séquentiel : ce sont quelques adresses, et elles partagent le réseau avec un
    // balayage de 254 adresses qui tourne au même moment.
    for (const entry of announced) {
      try {
        const probe = await app.probeAddress(entry.address, community);

        if (probe.outcome === 'ups') {
          const finding = this.fromProbe(probe, community, 161, entry.mac, entry.vendor);
          this.discovered = dedupeByHost([...this.discovered, finding]);
          this.note(`découverte : ${entry.address} est un onduleur ${entry.vendor ?? ''}`.trim());
          continue;
        }

        if (probe.outcome === 'snmp') continue;

        // Annoncée par l'ARP, donc présente ; muette en SNMP, donc à activer.
        if (!this.silent.includes(entry.address)) this.silent.push(entry.address);
        this.note(`découverte : ${entry.address} (${entry.vendor ?? 'marque inconnue'}) est là mais muette en SNMP`);
      } catch (error) {
        trace.warn('pair', `sonde de découverte échouée sur ${entry.address}`, error);
      }
    }
  }

  /** Une ligne à partir d'une sonde d'adresse. */
  private fromProbe(
    probe: AddressProbe,
    community: string,
    port: number,
    mac: string | null,
    vendor: string | null,
  ): Finding {
    const identity = probe.identity ?? { model: null, manufacturer: null, serial: null };
    const finding: Finding = {
      host: probe.host,
      name: probe.name,
      model: identity.model,
      manufacturer: identity.manufacturer,
      serial: identity.serial,
      source: probe.source,
      version: probe.version ?? 'v2c',
      description: probe.description,
      vendor,
    };

    if (probe.outcome !== 'ups' || probe.source === null || probe.version === null) return finding;

    return {
      ...finding,
      device: buildCandidate({
        host: probe.host,
        source: probe.source,
        version: probe.version,
        community,
        port,
        mac,
        vendor,
        model: identity.model,
        manufacturer: identity.manufacturer,
        serial: identity.serial,
        sysName: probe.name,
      }).device,
    };
  }

  /** Une ligne à partir d'une trouvaille du balayage. */
  private fromScan(found: ScanFinding, community: string): Finding {
    const finding: Finding = {
      host: found.host,
      name: found.name,
      model: found.model,
      manufacturer: found.manufacturer,
      serial: found.serial,
      source: found.source,
      // Le balayage interroge en v2c ; l'utilisateur peut passer en v1 dans les réglages
      // si son agent l'exige, ce que la sonde manuelle négocie de toute façon.
      version: 'v2c',
      description: found.description,
      vendor: null,
    };

    if (found.source === null) return finding;

    return {
      ...finding,
      device: buildCandidate({
        host: found.host,
        source: found.source,
        version: 'v2c',
        community,
        port: 161,
        mac: null,
        vendor: null,
        model: found.model,
        manufacturer: found.manufacturer,
        serial: found.serial,
        sysName: found.name,
      }).device,
    };
  }
}

/** Une ligne vide, pour les verdicts qui ne décrivent aucun appareil. */
function emptyFinding(host: string): Finding {
  return {
    host,
    name: null,
    model: null,
    manufacturer: null,
    serial: null,
    source: null,
    version: 'v2c',
    description: null,
    vendor: null,
  };
}

/** Le numéro de série mémorisé à l'adoption, quand il y en a un. */
function storedSerial(device: Homey.Device): string | null {
  const stored = device.getStoreValue('serial') as unknown;
  return typeof stored === 'string' && stored.trim() !== '' ? stored : null;
}

/**
 * L'erreur de balayage, dite en une phrase que la vue peut afficher telle quelle.
 *
 * Un code interne montré à l'utilisateur (`unknown-subnet`) ne lui apprend rien, et une
 * liste vide sans explication l'envoie chercher un problème qui n'existe pas.
 */
function scanError(error: string | null, subnet: string | null): string | null {
  if (error === null) return null;
  if (error === 'unknown-subnet') return 'the app could not work out which subnet to sweep';
  return subnet === null ? error : `${subnet}.0/24: ${error}`;
}

/** Pourquoi une réparation n'a pas abouti, en une phrase. */
function repairMessage(outcome: string, host: string): string {
  switch (outcome) {
    case 'snmp':
      return `${host} answers SNMP, but it is not a UPS.`;
    case 'reachable':
      return `${host} is reachable but silent over SNMP — the service is almost certainly switched off.`;
    default:
      return `no SNMP answer from ${host}.`;
  }
}
