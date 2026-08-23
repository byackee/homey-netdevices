/**
 * Le driver NAS / hôte.
 *
 * Il ne relève rien : chaque appareil s'interroge lui-même. Ce qui vit ici, c'est ce qui
 * est **commun à tous les appareils du driver** — les écouteurs des cartes Flow, qu'il
 * faut enregistrer une seule fois par driver et non une fois par appareil — et le
 * **pairing**, qui vit ici parce qu'une session de pairing est liée au driver depuis
 * lequel elle démarre (plan §3.7).
 *
 * 🔴 **Le balayage n'est pas refait.** Il appartient à l'app (`app.mts`), qui le tient
 * pour tous les drivers : « le premier driver appairé paie le balayage, chaque driver
 * suivant lit le résultat en cache et le filtre à sa propre classe ». Ce driver-ci prend
 * donc les adresses que le balayage a vues — celles qui parlent un dialecte onduleur
 * **comme** celles qui parlent SNMP sans en être un, un NAS étant très exactement ce
 * second cas — et leur pose sa propre question : « parles-tu HOST-RESOURCES-MIB ? ».
 * Lancer un second balayage de /24 en parallèle du premier doublerait la pression sur
 * les descripteurs de fichier d'un Homey qui n'en a pas tant que ça.
 */

import Homey from 'homey';

import type NetDevicesApp from '../../app.mjs';
import type { ScanFinding } from '../../app.mjs';
import { SnmpClient, negotiateVersion, type SnmpVersion } from '../../lib/snmp/client.mjs';
import { vendorForMac } from '../../lib/snmp/oui.mjs';
import { trace } from '../../lib/snmp/trace.mjs';
import { planNasCapabilities } from '../../lib/nas/capability-map.mjs';
import { probeHost, readNasSnapshot } from '../../lib/nas/host-reader.mjs';
import { NasVolumeDetector, type NasChangeSet, type VolumeCrossing } from '../../lib/nas/poll-engine.mjs';
import {
  communityOf,
  dedupeByHost,
  hostOf,
  offerHost,
  type NasPairingDevice,
} from './pairing.mjs';
import type NasDevice from './device.mjs';

/**
 * Budgets de la sonde d'une adresse.
 *
 * Une session de pairing n'a pas la coupure à dix secondes d'un appel d'API d'app, mais
 * un utilisateur qui attend devant un écran figé, si. Chaque étape est donc courte et
 * sans réessai : négociation de version, puis une sonde d'une requête, puis — seulement
 * si elle passe — le cycle complet qui coûte deux parcours de table.
 */
const PROBE_NEGOTIATE_MS = 2_000;
const PROBE_READ_MS = 2_500;

/**
 * Une ligne, telle que la vue de pairing la lit.
 *
 * 🔴 Forme **plate**, et c'est un contrat : `drivers/nas/pair/start.html` lit `host`,
 * `name`, `description`, `vendor`, `version` et `device` directement sur cet objet. Un
 * champ renommé ici ne casse rien de visible — la vue affiche simplement une ligne vide,
 * ou une liste vide, sans une erreur.
 */
interface Finding {
  host: string;
  /** `sysName` : le nom que la machine se donne, et donc celui que l'utilisateur reconnaît. */
  name: string | null;
  /** `sysDescr`, tronqué. */
  description: string | null;
  /** La marque déduite du préfixe OUI, quand la découverte a vu passer la MAC. */
  vendor: string | null;
  /** La version sur laquelle l'hôte a effectivement répondu. */
  version: SnmpVersion;
  /** Combien de volumes le tri a retenus. Affiché, jamais utilisé pour décider. */
  volumes: number;
  /**
   * La charge utile de pairing, assemblée par `pairing.mts`.
   *
   * Présente uniquement sur un hôte qui a livré au moins une mesure. C'est la seule forme
   * dont les clés admises sont vérifiées par le compilateur **et** par un test
   * (`test/nas/pairing.test.mts`) ; une vue qui l'adopte telle quelle ne peut pas vider la
   * liste avec une clé en trop.
   */
  device?: NasPairingDevice;
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
  /**
   * Répondent en SNMP sans parler HOST-RESOURCES-MIB : un diagnostic, pas du bruit.
   *
   * « Trois appareils parlent SNMP et aucun n'est un hôte » et « rien n'a répondu » sont
   * deux situations qui envoient l'utilisateur à deux endroits différents.
   */
  others: Finding[];
  /** Adresses présentes sur le réseau et muettes en SNMP : le symptôme d'un SNMP éteint. */
  reachable: string[];
}

/**
 * Le verdict sur une adresse saisie à la main.
 *
 * `outcome` est **machine**, jamais du texte : la formulation appartient à la vue, qui
 * seule connaît la langue de l'utilisateur.
 */
interface ProbeReply extends Finding {
  /** `host` | `snmp` | `silent` | `no-host` | `already-paired` | `nothing-readable`. */
  outcome: string;
}

/** Ce que la vue de réparation reçoit. */
interface RepairReply {
  ok: boolean;
  message?: string;
  /** Le nom trouvé à cette adresse, quand ce n'est pas la bonne machine. */
  found?: string;
  /** Celui qu'on attendait. */
  expected?: string;
}

export default class NasDriver extends Homey.Driver {
  override async onInit(): Promise<void> {
    this.registerVolumeTrigger();
    this.registerConditions();
    this.registerActions();
  }

  /**
   * « Un volume dépasse X % ».
   *
   * 🔴 Le franchissement se juge **ici**, à partir des deux bornes portées par l'état de
   * l'événement, parce que le seuil appartient à chaque Flow : deux Flows réglés à 80 % et
   * à 95 % doivent tous deux partir au bon moment sur un seul relevé SNMP. Un
   * franchissement, pas un état : rester trois semaines au-dessus du seuil ne redéclenche
   * rien.
   *
   * Et une carte de **device** portant un token de volume, plutôt qu'une carte par
   * volume : Homey ne génère aucune carte de Flow pour une sous-capability — ni pour
   * `nas_storage_used.volume1`, ni pour les trois tensions de l'onduleur. Une carte par
   * volume supposerait d'ailleurs de connaître les volumes avant le pairing.
   */
  private registerVolumeTrigger(): void {
    this.homey.flow
      .getDeviceTriggerCard('nas_volume_above')
      .registerRunListener(async (args: { percent?: number }, state: VolumeCrossing) => {
        const threshold = Number(args.percent);
        if (!Number.isFinite(threshold)) return false;
        return NasVolumeDetector.crossedAbove(state, threshold);
      });
  }

  /**
   * Les conditions numériques rendent **faux** sur une mesure inconnue.
   *
   * C'est le sens de la condition qui l'impose : « il reste de la place sur les volumes »
   * sert à protéger une sauvegarde. Répondre « oui » parce qu'on n'a pas su lire, ou
   * traiter le `null` comme un 0 %, revient dans les deux cas à décider à l'aveugle.
   */
  private registerConditions(): void {
    this.homey.flow
      .getConditionCard('nas_cpu_over')
      .registerRunListener(async (args: { device: NasDevice; percent?: number }) => {
        const load = args.device.measured('cpu');
        return load !== null && load > Number(args.percent);
      });

    this.homey.flow
      .getConditionCard('nas_volume_over')
      .registerRunListener(async (args: { device: NasDevice; percent?: number }) => {
        const fullest = args.device.measured('fullest');
        return fullest !== null && fullest > Number(args.percent);
      });

    this.homey.flow
      .getConditionCard('nas_memory_over')
      .registerRunListener(async (args: { device: NasDevice; percent?: number }) => {
        const memory = args.device.measured('memory');
        return memory !== null && memory > Number(args.percent);
      });
  }

  /**
   * La seule action, et elle est en lecture.
   *
   * 🔴 Pas d'« éteindre », pas de « tuer un processus ». HOST-RESOURCES-MIB expose bien
   * `hrSWRunStatus` en écriture — y poser `invalid(4)` **termine le processus** — et
   * `hrFSLastFullBackupDate`. Rien de tout cela n'a sa place derrière une carte de Flow
   * qu'on peut déclencher par erreur.
   */
  private registerActions(): void {
    this.homey.flow
      .getActionCard('nas_refresh')
      .registerRunListener(async (args: { device: NasDevice }) => {
        await args.device.refreshNow();
      });
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  /** Les hôtes reconnus, retenus entre deux interrogations de la vue. */
  private confirmed: Finding[] = [];
  /** Ce qui parle SNMP sans parler HOST-RESOURCES-MIB. */
  private declined: Finding[] = [];
  /** Les adresses annoncées par la découverte qui ne répondent pas en SNMP. */
  private silent: string[] = [];
  /** Les adresses déjà interrogées pendant cette session, pour ne pas les resonder. */
  private examined = new Set<string>();
  /** La communauté du balayage en cours, pour que l'appareil adopté soit lu avec elle. */
  private scanCommunity = 'public';
  /** Une sonde de fond en vol, pour ne pas en lancer deux. */
  private examining = false;

  /** Une trace visible depuis `GET /trace` : un pairing muet ne se diagnostique pas autrement. */
  private note(message: string, detail?: unknown): void {
    trace.info('pair-nas', message, detail);
    this.log(message);
  }

  /**
   * Conduit la session de pairing.
   *
   * 🔴 **Une seule vue custom**, sans navigation. Une vue custom ne peut pas naviguer vers
   * un template système : `showView`/`nextView` échouent dans le frontend de pairing et
   * laissent un écran blanc, ou ferment l'assistant sans rien créer (rétro §8.1, panne 5).
   * La vue appelle donc `Homey.createDevice()` elle-même.
   *
   * 🔴 **Requête/réponse, jamais de push.** Tout passe par `Homey.emit()` de la vue vers
   * ces handlers, et la vue interroge. Avec `session.emit()` dans l'autre sens, « le
   * balayage a échoué » et « les événements ne sont jamais arrivés » deviennent
   * indiscernables (panne 9).
   *
   * 🔴 **Aucun `session.showView()` depuis un handler** : Homey attend le retour du
   * handler, le handler attendrait la transition, et la session se fige (panne 4).
   */
  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    this.note('onPair start');
    this.confirmed = [];
    this.declined = [];
    this.silent = [];
    this.examined = new Set();

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
      this.scanCommunity = community;
      this.note('scan_start', { communauté: community === 'public' ? 'public' : '(personnalisée)' });

      const app = this.homey.app as NetDevicesApp;
      const state = await app.startScan(this.pairedHosts(), community);

      // Lancée, pas attendue : sonder les adresses annoncées prend le temps qu'il faut, et
      // la vue doit pouvoir afficher sa barre pendant ce temps-là.
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

      // Le balayage classe ses trouvailles selon qu'elles parlent un dialecte *onduleur*.
      // Ce driver-ci n'en a rien à faire : un NAS relayant un onduleur est dans `found`,
      // un NAS sans onduleur est dans `others`, et les deux sont des hôtes. On les
      // reprend donc tous et on pose sa propre question.
      void this.examineAll([...state.found, ...state.others], this.scanCommunity);

      const taken = this.pairedHosts();
      const ids = this.pairedIds();
      const found = dedupeByHost([...this.confirmed])
        .filter((finding) => !taken.has(finding.host))
        .filter((finding) => finding.device === undefined || !ids.has(finding.device.data.id));

      if (!state.running) {
        this.note(`balayage terminé : ${found.length} hôte(s), ${this.declined.length} autre(s) en SNMP, ${this.silent.length} muet(s)`);
      }

      return {
        running: state.running || this.examining,
        done: state.running ? Math.min(state.probed, state.total) : state.total,
        total: state.total,
        subnet: state.subnet,
        error: scanError(state.error, state.subnet),
        found,
        others: dedupeByHost([...this.declined]).filter((finding) => !taken.has(finding.host)),
        reachable: [...this.silent],
      };
    });

    session.setHandler('probe', async (data: unknown): Promise<ProbeReply> => {
      const host = hostOf(data);
      const community = communityOf(data);
      this.note(`probe ${host || '(vide)'}`);

      if (host === '') return { ...emptyFinding(''), outcome: 'no-host' };
      if (this.pairedHosts().has(host)) return { ...emptyFinding(host), outcome: 'already-paired' };

      const result = await this.examine(host, community, null, null);
      this.note(`probe ${host}: ${result.outcome}`, result.finding.device?.name);
      return { ...result.finding, outcome: result.outcome };
    });

    // Ce que la vue a réellement créé. Sans cette ligne, un `createDevice()` qui échoue
    // côté Homey ne laisse aucune trace du côté de l'app.
    session.setHandler('adopted', async (data: unknown) => {
      this.note('adopted', data);
    });
  }

  /**
   * La réparation, qui existe pour une panne précise : l'hôte a changé d'adresse.
   *
   * 🔴 Elle vérifie que c'est **la même machine** avant d'écrire quoi que ce soit.
   * L'appariement se fait sur l'identité SNMP, jamais sur l'adresse : pointer une
   * réparation sur la machine voisine ne lève rien, ne se voit jamais, et l'appareil
   * continue de relever — simplement plus le bon hôte.
   *
   * ⚠️ Le repère est `sysName`, faute de mieux : HOST-RESOURCES-MIB ne publie aucun
   * numéro de série. Il est donc **plus faible** que la vérification de série de
   * l'onduleur — quelqu'un qui renomme sa machine puis la répare verra un refus. Le refus
   * est explicite, dit les deux noms, et c'est le bon sens de l'erreur : mieux vaut un
   * utilisateur qui doit confirmer qu'un appareil qui relève silencieusement la mauvaise
   * machine.
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

      const result = await this.examine(host, community, null, null);
      if (result.outcome !== 'host' || result.version === null) {
        this.note(`setAddress ${host}: ${result.outcome}`);
        return { ok: false, message: repairMessage(result.outcome, host) };
      }

      const expected = storedName(device);
      const found = result.finding.name;

      // Deux noms connus qui diffèrent : c'est une autre machine. On n'écrit rien et on le
      // dit, plutôt que de faire pointer l'appareil sur le voisin.
      if (expected !== null && found !== null && expected !== found) {
        this.note(`setAddress ${host}: nom ${found} ≠ ${expected}, réglages inchangés`);
        return { ok: false, found, expected };
      }

      await device.setSettings({ host, community, version: result.version });
      this.note(`setAddress ${host}: réglages réécrits (nom ${found ?? 'inconnu'})`);
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
   * Le filtre par adresse ne suffit pas : un hôte qui vient de changer d'IP serait offert
   * une seconde fois, et l'utilisateur se retrouverait avec deux appareils pour une seule
   * machine — dont un définitivement muet.
   */
  private pairedIds(): Set<string> {
    return new Set(this.getDevices().map((device) => String(device.getData().id ?? '')));
  }

  /**
   * Les adresses que la stratégie de découverte a vues, avec leur marque.
   *
   * La stratégie partagée avec le driver onduleur résout des préfixes OUI par ARP : elle
   * donne une adresse et une MAC, jamais un modèle. Chaque adresse est donc **sondée en
   * SNMP** avant d'être offerte — une MAC Synology ne prouve pas qu'un agent répond en
   * face, et proposer un appareil illisible ne ferait que repousser la déception.
   *
   * 🔴 C'est le seul chemin qui rende une MAC, et la MAC est le seul identifiant vraiment
   * matériel dont ce driver dispose : HOST-RESOURCES-MIB ne publie pas de numéro de série.
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
      // Une stratégie absente ou pas encore prête ne doit pas faire tomber le pairing : le
      // balayage trouve les mêmes appareils, juste plus lentement et sans MAC.
      trace.warn('pair-nas', 'découverte illisible', error);
      return [];
    }
  }

  /** Sonde en SNMP ce que la découverte a annoncé. */
  private async probeAnnounced(community: string): Promise<void> {
    const taken = this.pairedHosts();
    const announced = this.announcedAddresses().filter((entry) => !taken.has(entry.address));

    this.note(`découverte : ${announced.length} adresse(s) annoncée(s)`);

    // Séquentiel : ce sont quelques adresses, et elles partagent le réseau avec un
    // balayage de 254 adresses qui tourne au même moment.
    for (const entry of announced) {
      const result = await this.examine(entry.address, community, entry.mac, entry.vendor);
      if (result.outcome === 'silent' && !this.silent.includes(entry.address)) {
        // Annoncée par l'ARP, donc présente ; muette en SNMP, donc à activer.
        this.silent.push(entry.address);
        this.note(`découverte : ${entry.address} (${entry.vendor ?? 'marque inconnue'}) est là mais muette en SNMP`);
      }
    }
  }

  /**
   * Sonde en tâche de fond ce que le balayage a vu répondre en SNMP.
   *
   * Une seule passe à la fois : la vue interroge `scan_status` toutes les 1,5 s et
   * relancerait sinon une salve par interrogation. `examined` retient ce qui a déjà été
   * tranché, si bien qu'une adresse n'est jamais sondée deux fois dans une session.
   */
  private async examineAll(candidates: readonly ScanFinding[], community: string): Promise<void> {
    if (this.examining) return;
    const fresh = candidates.filter((finding) => !this.examined.has(finding.host));
    if (fresh.length === 0) return;

    this.examining = true;
    try {
      for (const finding of fresh) {
        await this.examine(finding.host, community, null, null);
      }
    } finally {
      this.examining = false;
    }
  }

  /** Ce qu'une adresse a répondu, et ce qu'on en a fait. */
  private async examine(
    host: string,
    community: string,
    mac: string | null,
    vendor: string | null,
  ): Promise<{ outcome: ProbeReply['outcome']; version: SnmpVersion | null; finding: Finding }> {
    this.examined.add(host);

    const version = await negotiateVersion(host, community, PROBE_NEGOTIATE_MS);
    if (version === null) return { outcome: 'silent', version: null, finding: emptyFinding(host) };

    const client = new SnmpClient({ host, community, version, timeout: PROBE_READ_MS, retries: 0 });

    // Deux temps, et l'ordre compte : une sonde d'une requête écarte l'immense majorité
    // des adresses avant de payer le cycle complet, qui coûte deux parcours de table.
    let speaks = false;
    try {
      speaks = await probeHost(client);
    } catch (error) {
      trace.warn('pair-nas', `${host} a cessé de répondre pendant la sonde`, error);
      return { outcome: 'snmp', version, finding: { ...emptyFinding(host), version, vendor } };
    }

    if (!speaks) {
      const finding: Finding = { ...emptyFinding(host), version, vendor };
      this.remember(this.declined, finding);
      return { outcome: 'snmp', version, finding };
    }

    let snapshot;
    try {
      snapshot = await readNasSnapshot(client);
    } catch (error) {
      trace.warn('pair-nas', `${host} a cessé de répondre pendant le relevé`, error);
      return { outcome: 'snmp', version, finding: { ...emptyFinding(host), version, vendor } };
    }

    const plan = planNasCapabilities(snapshot);
    const finding: Finding = {
      host,
      name: snapshot.name,
      description: snapshot.description,
      vendor,
      version,
      volumes: snapshot.volumes.length,
    };

    // La décision — offrir, ou ne pas offrir — vit dans `pairing.mts`, où elle se teste.
    const offer = offerHost({
      host,
      version,
      community,
      mac,
      vendor,
      name: snapshot.name,
      description: snapshot.description,
      capabilities: plan.capabilities,
      options: plan.options,
      volumeCount: snapshot.volumes.length,
      takenIds: this.pairedIds(),
    });

    if (offer.candidate === null) {
      this.note(`${host} parle HOST-RESOURCES mais ne rend aucune mesure`, plan.omitted);
      this.remember(this.declined, finding);
      return { outcome: offer.reason, version, finding };
    }

    const complete: Finding = { ...finding, device: offer.candidate.device };
    this.remember(this.confirmed, complete);
    this.note(`${host} est un hôte : ${plan.capabilities.length} mesure(s), ${snapshot.volumes.length} volume(s)`);
    return { outcome: offer.reason, version, finding: complete };
  }

  /** Range une trouvaille sans jamais la doubler. */
  private remember(list: Finding[], finding: Finding): void {
    const index = list.findIndex((entry) => entry.host === finding.host);
    if (index === -1) list.push(finding);
    else list[index] = finding;
  }
}

/** Une ligne vide, pour les verdicts qui ne décrivent aucun appareil. */
function emptyFinding(host: string): Finding {
  return { host, name: null, description: null, vendor: null, version: 'v2c', volumes: 0 };
}

/** Le nom mémorisé à l'adoption, quand il y en a un. */
function storedName(device: Homey.Device): string | null {
  const id = String(device.getData().id ?? '');
  const prefix = 'nas:name:';
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
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
      return `${host} answers SNMP, but it does not publish HOST-RESOURCES-MIB.`;
    case 'nothing-readable':
      return `${host} publishes HOST-RESOURCES-MIB but no readable measurement.`;
    default:
      return `no SNMP answer from ${host}.`;
  }
}

/** Réexporté pour les tests, qui vérifient l'état d'événement que la carte reçoit. */
export type { NasChangeSet };
