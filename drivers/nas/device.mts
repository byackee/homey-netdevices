/**
 * L'appareil Homey « NAS ou hôte ».
 *
 * Adaptateur, et rien d'autre : il branche des timers Homey sur les décisions de
 * `lib/nas/poll-engine.mts`, et écrit sur des capabilities ce que
 * `lib/nas/capability-map.mts` a décidé. Toute règle qui mérite un test vit dans l'un de
 * ces deux modules, jamais ici — `Homey.Device` ne s'instancie pas hors du runtime Homey,
 * et une règle qu'aucun test n'atteint est une règle qu'on découvre fausse chez
 * l'utilisateur.
 *
 * 🔴 **Aucun SET, sans exception.** `class: 'sensor'`, aucune capability `setable`, aucun
 * appel d'écriture SNMP nulle part dans ce fichier. HOST-RESOURCES-MIB expose bien de
 * l'écriture — `hrFSLastFullBackupDate`, et surtout `hrSWRunStatus` en `invalid(4)`, qui
 * **tue un processus** — et rien de tout cela n'a sa place derrière une tuile qu'on peut
 * toucher par erreur.
 *
 * 🔴 **Aucune écriture persistante par tick** (plan §8.6). netprinter réécrivait des
 * titres de capability à chaque relevé ; `setSettings`, `setStoreValue` et
 * `setCapabilityOptions` n'apparaissent ici que sur changement avéré, et
 * `syncCapabilities` est idempotent — quand le plan est déjà satisfait, il n'écrit rien.
 */

import Homey from 'homey';

import { SnmpClient, SnmpUnreachableError, type SnmpVersion } from '../../lib/snmp/client.mjs';
import { syncCapabilities } from '../../lib/ups/capability-sync.mjs';
import { nasCapabilityValues, planNasCapabilities } from '../../lib/nas/capability-map.mjs';
import { readDetail, readLive } from '../../lib/nas/host-reader.mjs';
import {
  HostContactTracker,
  NAS_DETAIL_RHYTHM,
  NAS_LIVE_RHYTHM,
  NasChangeDetector,
  NasVolumeDetector,
  PollGate,
  fullestVolume,
  intervalMs,
  type HostOutcome,
  type NasChangeSet,
  type VolumeCrossing,
} from '../../lib/nas/poll-engine.mjs';
import {
  NAS_LIVE_UNKNOWN,
  NAS_UNKNOWN_DETAIL,
  type NasSnapshot,
} from '../../lib/nas/snapshot.mjs';

/** Ce que le pairing a écrit, et que l'utilisateur peut corriger ensuite. */
interface NasSettings {
  host: string;
  community: string;
  port: number;
  version: SnmpVersion;
  liveInterval: number;
  detailInterval: number;
}

/** Les réglages dont un changement invalide la conversation SNMP en cours. */
const CONNECTION_KEYS = ['host', 'community', 'port', 'version'];

/**
 * Délai avant de reconstruire le client après un changement de réglage.
 *
 * Homey n'applique les nouvelles valeurs qu'**après** la résolution de `onSettings` :
 * relire les réglages depuis ce handler rendrait les anciennes.
 */
const SETTINGS_SETTLE_MS = 500;

/** Ce qu'un token de Flow affiche quand la mesure est absente. */
const UNKNOWN_TOKEN = '—';

export default class NasDevice extends Homey.Device {
  private client!: SnmpClient;

  private liveTimer: NodeJS.Timeout | null = null;
  private detailTimer: NodeJS.Timeout | null = null;
  /** Une garde par groupe : le relevé lent, qui parcourt deux tables, ne doit pas retarder le rapide. */
  private readonly liveGate = new PollGate();
  private readonly detailGate = new PollGate();

  private readonly contact = new HostContactTracker();
  private readonly changes = new NasChangeDetector();
  private readonly volumes = new NasVolumeDetector();

  /** N'annoncer les capabilities orphelines qu'une fois, pas à chaque relevé. */
  private orphansLogged = false;

  /**
   * Tout ce qu'on sait à cet instant, les deux groupes fusionnés.
   *
   * `nasCapabilityValues()` raisonne sur un snapshot complet ; les deux rythmes n'en
   * rafraîchissent chacun qu'une moitié. Garder l'union ici évite d'écraser les volumes
   * du groupe lent à chaque relevé rapide.
   */
  private current: NasSnapshot = {
    name: null,
    description: null,
    ...NAS_LIVE_UNKNOWN,
    ...NAS_UNKNOWN_DETAIL,
  };

  override async onInit(): Promise<void> {
    this.buildClient();

    // 🔴 Le relevé lent est lancé **en premier** : c'est lui qui découvre `memoryIndex`,
    // sans lequel le relevé rapide ne sait pas quelle ligne de `hrStorageTable` porte la
    // mémoire. Lancés, pas attendus : Homey initialise les appareils en séquence, et
    // bloquer ici sur un hôte injoignable retiendrait tous ceux qui suivent.
    void this.pollDetail()
      .catch((error: unknown) => this.error(`Relevé lent initial : ${describe(error)}`))
      .finally(() => {
        this.scheduleDetail();
        void this.pollLive()
          .catch((error: unknown) => this.error(`Relevé rapide initial : ${describe(error)}`))
          .finally(() => this.scheduleLive());
      });
  }

  // -------------------------------------------------------------------------
  // Réglages et transport
  // -------------------------------------------------------------------------

  private readSettings(): NasSettings {
    return {
      host: String(this.getSetting('host') ?? ''),
      community: String(this.getSetting('community') ?? 'public'),
      // 161 sauf mention contraire. Un agent peut ecouter ailleurs — un `snmpd` non
      // privilegie, un conteneur, une redirection de port vers un NAS distant.
      port: Number(this.getSetting('port') ?? 161),
      version: (this.getSetting('version') as SnmpVersion) ?? 'v2c',
      liveInterval: Number(this.getSetting('live_interval') ?? NAS_LIVE_RHYTHM.defaultSeconds),
      detailInterval: Number(this.getSetting('detail_interval') ?? NAS_DETAIL_RHYTHM.defaultSeconds),
    };
  }

  private buildClient(): void {
    const { host, community, port, version } = this.readSettings();
    // Un timeout plus long que celui de l'onduleur, et un rythme six fois plus lent pour
    // le payer : le relevé lent parcourt deux tables, et un NAS occupé à reconstruire un
    // RAID répond lentement sans être en panne.
    this.client = new SnmpClient({ host, community, version, port, timeout: 4_000, retries: 1 });
  }

  // -------------------------------------------------------------------------
  // Les deux rythmes
  // -------------------------------------------------------------------------

  /**
   * Un timeout chaîné plutôt qu'un intervalle : un hôte lent ne peut pas empiler des
   * relevés derrière lui-même. `homey.setTimeout` plutôt que le global, parce que Homey
   * l'annule à l'arrêt de l'app — un timer nu continuerait de tirer contre un appareil
   * détruit.
   */
  private scheduleLive(): void {
    if (this.stopped) return;
    this.liveTimer = this.homey.setTimeout(() => {
      void this.pollLive()
        .catch((error: unknown) => this.error(`Relevé rapide : ${describe(error)}`))
        .finally(() => this.scheduleLive());
    }, intervalMs(this.readSettings().liveInterval, NAS_LIVE_RHYTHM));
  }

  private scheduleDetail(): void {
    if (this.stopped) return;
    this.detailTimer = this.homey.setTimeout(() => {
      void this.pollDetail()
        .catch((error: unknown) => this.error(`Relevé lent : ${describe(error)}`))
        .finally(() => this.scheduleDetail());
    }, intervalMs(this.readSettings().detailInterval, NAS_DETAIL_RHYTHM));
  }

  /**
   * L'appareil est-il retiré, ou l'app en train de s'arrêter ?
   *
   * 🔴 `clearTimers()` annule le timer **en attente**, mais un relevé déjà **en vol** au
   * moment de la suppression rappelle `schedule…()` depuis son `.finally()` — après le
   * nettoyage. La chaîne ressuscitait donc toute seule, et un appareil supprimé
   * continuait d'interroger le réseau jusqu'au redémarrage de l'app.
   *
   * Le drapeau est la seule chose qu'un `.finally()` en retard puisse encore consulter.
   */
  private stopped = false;

  private clearTimers(): void {
    this.stopped = true;
    if (this.liveTimer !== null) this.homey.clearTimeout(this.liveTimer);
    if (this.detailTimer !== null) this.homey.clearTimeout(this.detailTimer);
    this.liveTimer = null;
    this.detailTimer = null;
  }

  /**
   * Le groupe rapide (~60 s) : uptime, charge CPU, mémoire.
   *
   * C'est **le seul** qui alimente le suivi de contact. Le groupe lent n'a pas voix au
   * chapitre : à quinze minutes, il conclurait « injoignable » trois quarts d'heure après
   * le fait, et ses échecs se mêleraient à ceux du rapide dans le même compteur.
   */
  private async pollLive(): Promise<void> {
    await this.liveGate.run(async () => {
      let outcome: HostOutcome;
      try {
        outcome = this.contact.succeeded(await readLive(this.client, this.current.memoryIndex));
      } catch (error) {
        outcome = this.contact.failed();
        this.logFailure(outcome, error);
      }
      await this.applyOutcome(outcome);
    });
  }

  /**
   * Le groupe lent (~15 min) : la carte des volumes, la température, l'identité.
   *
   * Son échec ne rend **pas** l'appareil indisponible et ne touche pas au compteur : un
   * agent qui bride les requêtes peut refuser un parcours de table tout en répondant aux
   * `get` du groupe rapide, et c'est le rapide qui dit si la machine est là.
   */
  private async pollDetail(): Promise<void> {
    await this.detailGate.run(async () => {
      try {
        const detail = await readDetail(this.client);
        this.current = { ...this.current, ...detail };
        this.logRejected(detail.rejected);
        await this.writeValues();
        await this.fireVolumeCrossings(this.volumes.observe(detail.volumes));
      } catch (error) {
        this.log(`Relevé lent sans réponse (le reste continue) : ${describe(error)}`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Écriture
  // -------------------------------------------------------------------------

  /**
   * Applique ce que le suivi de contact a décidé.
   *
   * `outcome.live === null` veut dire « n'écris rien » et non « écris du vide » : sous le
   * seuil, un datagramme UDP perdu ne doit pas faire clignoter la tuile.
   */
  private async applyOutcome(outcome: HostOutcome): Promise<void> {
    if (outcome.live !== null) {
      this.current = { ...this.current, ...outcome.live };
      await this.writeValues();
      await this.fireTriggers(this.changes.observe(outcome.live));
    }
    await this.applyAvailability(outcome);
  }

  private async applyAvailability(outcome: HostOutcome): Promise<void> {
    if (outcome.availability === 'available') {
      if (!this.getAvailable()) await this.setAvailable().catch(() => {});
      return;
    }
    if (outcome.reason === 'absorbing' || !this.getAvailable()) return;

    await this.setUnavailable(this.homey.__({
      en: 'No SNMP answer. Check the address, the community, and that the SNMP service is still enabled on the host.',
      fr: 'Aucune réponse SNMP. Vérifiez l’adresse, la communauté, et que le service SNMP est toujours activé sur l’hôte.',
      nl: 'Geen SNMP-antwoord. Controleer het adres, de community en of de SNMP-dienst nog is ingeschakeld op de host.',
    })).catch(() => {});
  }

  /**
   * Branche l'alignement des capabilities sur `this`.
   *
   * 🔴 **C'est la ligne que la revue a trouvée manquante ailleurs**, et le défaut le plus
   * grave qu'elle ait relevé : le mapping des capabilities existait, il était testé, et il
   * n'était appelé de nulle part — douze mesures sur treize étaient calculées toutes les
   * dix secondes puis jetées avant d'atteindre Homey. Ni `npm test` ni `homey app
   * validate` ne pouvaient le voir, parce que la carte était testée à fond en isolation et
   * que personne ne testait qu'on l'appelle.
   *
   * Ici l'appel est réel, il est en amont de chaque écriture, et
   * `test/nas/capability-sync.test.mts` interdit la régression.
   *
   * La logique vit dans `lib/ups/capability-sync.mts` — générique, elle prend un plan et
   * ne sait rien de la classe d'appareil — et pas dans ce fichier, pour la raison
   * habituelle : le paquet `homey` est la CLI et non le SDK runtime.
   */
  private async syncCapabilities(): Promise<void> {
    const result = await syncCapabilities(planNasCapabilities(this.current), {
      listCapabilities: () => this.getCapabilities(),
      addCapability: (id) => this.addCapability(id),
      setCapabilityOptions: (id, options) => this.setCapabilityOptions(id, options),
      setEnergy: (energy) => this.setEnergy(energy),
      log: (message) => this.log(message),
      error: (message) => this.error(message),
    });

    if (result.orphaned.length > 0 && !this.orphansLogged) {
      // Un volume démonté, ou une mesure que l'hôte a cessé de publier. Conservée :
      // `removeCapability` détruit l'historique Insights de façon irréversible, et une
      // mesure absente d'un cycle n'est pas une mesure disparue.
      this.log(`Capabilities sans source, conservées pour l'historique : ${result.orphaned.join(', ')}`);
      this.orphansLogged = true;
    }
  }

  private async writeValues(): Promise<void> {
    await this.syncCapabilities();
    for (const { id, value } of nasCapabilityValues(this.current, this.getCapabilities())) {
      await this.setCapabilityValue(id, value).catch((e: Error) =>
        this.error(`Impossible d'écrire ${id} : ${e.message}`));
    }
  }

  /**
   * Dit une fois ce que le tri des volumes a écarté.
   *
   * Un filtre dont on ne peut pas constater l'effet est un filtre qu'on découvre trop
   * agressif le jour où l'utilisateur demande où est passé son volume — et qu'on n'a
   * alors aucun moyen de lui répondre. Journalisé sur changement, jamais à chaque relevé.
   */
  private lastRejected = '';

  private logRejected(rejected: { label: string; reason: string }[]): void {
    const summary = rejected.map((entry) => `${entry.label} (${entry.reason})`).join(', ');
    if (summary === this.lastRejected) return;
    this.lastRejected = summary;
    if (summary !== '') this.log(`Lignes de stockage écartées : ${summary}`);
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------

  /** Les mesures telles qu'un token les montre. Une absence s'affiche, elle ne s'invente pas. */
  private tokens(): { uptime: string; cpu: string; memory: string } {
    const { uptimeDays, cpuLoad, memoryUsedPercent } = this.current;
    return {
      uptime: uptimeDays === null ? UNKNOWN_TOKEN : `${uptimeDays} j`,
      cpu: cpuLoad === null ? UNKNOWN_TOKEN : `${cpuLoad} %`,
      memory: memoryUsedPercent === null ? UNKNOWN_TOKEN : `${memoryUsedPercent} %`,
    };
  }

  private async trigger(card: string, tokens: object = {}, state: object = {}): Promise<void> {
    await this.homey.flow
      .getDeviceTriggerCard(card)
      .trigger(this, tokens, state)
      .catch((e: Error) => this.error(`Déclencheur ${card} : ${e.message}`));
  }

  private async fireTriggers(change: NasChangeSet): Promise<void> {
    if (!change.rebooted) return;
    const { cpu, memory } = this.tokens();
    await this.trigger('nas_rebooted', { cpu, memory }, change);
  }

  /**
   * Une carte par volume dont le remplissage a augmenté.
   *
   * Le seuil appartient à chaque Flow, pas à l'appareil : la carte part dès qu'un volume
   * s'est rempli, et son `runListener` décide du franchissement à son propre seuil. Sans
   * quoi deux Flows réglés à 80 % et 95 % exigeraient deux relevés.
   */
  private async fireVolumeCrossings(crossings: VolumeCrossing[]): Promise<void> {
    for (const crossing of crossings) {
      await this.trigger(
        'nas_volume_above',
        { volume: crossing.label, used: `${crossing.after} %` },
        crossing,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Ce que le driver appelle
  // -------------------------------------------------------------------------

  /** Relève le groupe rapide hors planning. Sert l'action Flow « relever maintenant ». */
  async refreshNow(): Promise<void> {
    await this.pollLive();
  }

  /**
   * Sert les conditions numériques.
   *
   * Rend `null` quand la mesure est inconnue ; c'est au driver de refuser la condition
   * plutôt que de la traiter comme un zéro — une valeur non lue n'est pas une machine au
   * repos, ni un disque vide.
   */
  measured(what: 'cpu' | 'memory' | 'temperature' | 'fullest'): number | null {
    switch (what) {
      case 'cpu': return this.current.cpuLoad;
      case 'memory': return this.current.memoryUsedPercent;
      case 'temperature': return this.current.temperature;
      case 'fullest': return fullestVolume(this.current.volumes)?.usedPercent ?? null;
    }
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  private logFailure(outcome: HostOutcome, error: unknown): void {
    const message = `${describe(error)} (échec ${outcome.failures})`;
    if (outcome.reason === 'absorbing') {
      this.log(`Relevé sans réponse, absorbé : ${message}`);
      return;
    }
    this.error(`Hôte injoignable : ${message}`);
  }

  override async onSettings({ changedKeys }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<void> {
    if (changedKeys.some((key) => CONNECTION_KEYS.includes(key))) {
      // Une adresse qui change peut désigner un **autre** hôte : les échecs d'avant, le
      // relevé d'avant et la carte des volumes d'avant portaient tous sur une conversation
      // qui n'existe plus. Les trois détecteurs repartent donc de zéro, faute de quoi le
      // premier relevé du nouvel hôte annoncerait un redémarrage et une salve de
      // franchissements de seuil qui n'ont jamais eu lieu.
      this.homey.setTimeout(() => {
        this.buildClient();
        this.contact.reset();
        this.changes.reset();
        this.volumes.reset();
        this.current = { ...this.current, ...NAS_LIVE_UNKNOWN, ...NAS_UNKNOWN_DETAIL };
        void this.pollDetail()
          .catch((error: unknown) => this.error(`Relevé lent après réglage : ${describe(error)}`))
          .finally(() => {
            void this.pollLive().catch((error: unknown) =>
              this.error(`Relevé rapide après réglage : ${describe(error)}`));
          });
      }, SETTINGS_SETTLE_MS);
    }

    if (changedKeys.includes('live_interval') || changedKeys.includes('detail_interval')) {
      this.homey.setTimeout(() => {
        this.clearTimers();
        // Un changement de réglage rebranche la chaîne : ce n'est pas un arrêt.
        this.stopped = false;
        this.scheduleLive();
        this.scheduleDetail();
      }, SETTINGS_SETTLE_MS);
    }
  }

  override async onUninit(): Promise<void> {
    this.clearTimers();
  }

  override async onDeleted(): Promise<void> {
    this.clearTimers();
  }
}

/** Un message lisible pour le journal, sans perdre la distinction « injoignable ». */
function describe(error: unknown): string {
  if (error instanceof SnmpUnreachableError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
