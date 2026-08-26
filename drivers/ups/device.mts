/**
 * L'appareil Homey « onduleur ».
 *
 * Adaptateur, et rien d'autre : il branche des timers Homey sur les décisions de
 * `poll-engine.mts`, et écrit sur des capabilities ce que `lib/ups/capability-map.mts`
 * a décidé. Toute règle qui mérite un test vit dans l'un de ces deux modules, jamais
 * ici — `Homey.Device` ne s'instancie pas hors du runtime Homey, et une règle de
 * coupure de courant qu'aucun test n'atteint est une règle qu'on découvre fausse le
 * soir où le courant saute.
 *
 * 🔴 **Aucun SET, sans exception** (plan §3.6). `upsControl` de la RFC 1628 est
 * entièrement en écriture et peut couper l'alimentation de tout ce qui est branché sur
 * l'onduleur — ce Homey compris. Aucun chemin de ce fichier n'appelle `set()`.
 *
 * 🔴 **Aucune écriture persistante par tick** (plan §8.6). netprinter réécrivait des
 * titres de capability à chaque relevé, toutes les 300 s ; le rythme rapide d'ici est
 * de 10 s, soit trente fois pire. `setSettings`, `setStoreValue` et
 * `setCapabilityOptions` n'apparaissent que sur changement avéré.
 */

import Homey from 'homey';

import { SnmpClient, SnmpUnreachableError, type SnmpVersion } from '../../lib/snmp/client.mjs';
import { capabilityValues, planCapabilities } from '../../lib/ups/capability-map.mjs';
import { renderAlarmSummary } from '../../lib/ups/alarm-summary.mjs';
import { syncCapabilities } from '../../lib/ups/capability-sync.mjs';
import {
  UNKNOWN_DETAIL,
  type UpsDetail,
  type UpsIdentity,
  type UpsLive,
  type UpsSnapshot,
  type UpsSource,
  type UpsSourceReader,
} from '../../lib/ups/snapshot.mjs';
import { detectUpsSource, readerForSource } from '../../lib/ups/sources.mjs';
import {
  ContactTracker,
  DETAIL_RHYTHM,
  LIVE_RHYTHM,
  LIVE_UNKNOWN,
  PollGate,
  UpsChangeDetector,
  intervalMs,
  type ContactOutcome,
  type UpsChangeSet,
} from './poll-engine.mjs';

/** Ce que le pairing a écrit, et que l'utilisateur peut corriger ensuite. */
interface UpsSettings {
  host: string;
  community: string;
  /** Le port UDP de l'agent. 161 partout, sauf configuration particulière. */
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

export default class UpsDevice extends Homey.Device {
  private client!: SnmpClient;
  /** `null` tant qu'aucune source n'a été reconnue : on ne devine pas de dialecte. */
  private reader: UpsSourceReader | null = null;

  private liveTimer: NodeJS.Timeout | null = null;
  private detailTimer: NodeJS.Timeout | null = null;
  /** Une garde par groupe : le relevé lent ne doit jamais retarder le rapide. */
  private readonly liveGate = new PollGate();
  private readonly detailGate = new PollGate();

  private readonly contact = new ContactTracker();
  private readonly changes = new UpsChangeDetector();

  /**
   * Tout ce qu'on sait à cet instant, les deux groupes fusionnés.
   *
   * `capabilityValues()` raisonne sur un snapshot complet ; les deux rythmes n'en
   * rafraîchissent chacun qu'une moitié. Garder l'union ici évite d'écraser les tensions
   * du groupe lent à chaque relevé rapide.
   */
  /** N'annoncer les capabilities orphelines qu'une fois, pas à chaque relevé. */
  private orphansLogged = false;

  private current: UpsSnapshot = {
    source: 'synology',
    model: null,
    manufacturer: null,
    serial: null,
    ...LIVE_UNKNOWN,
    ...UNKNOWN_DETAIL,
  };

  override async onInit(): Promise<void> {
    this.current.source = this.storedSource() ?? this.current.source;
    this.buildClient();
    this.reader = readerForSource(this.current.source);

    // Le premier relevé est lancé, pas attendu. Homey initialise les appareils en
    // séquence : bloquer ici sur un onduleur injoignable — jusqu'à un timeout SNMP
    // complet — retiendrait tous les appareils qui suivent.
    void this.pollLive().finally(() => this.scheduleLive());
    void this.pollDetail().finally(() => this.scheduleDetail());
  }

  // -------------------------------------------------------------------------
  // Réglages et transport
  // -------------------------------------------------------------------------

  private readSettings(): UpsSettings {
    return {
      host: String(this.getSetting('host') ?? ''),
      community: String(this.getSetting('community') ?? 'public'),
      // 161 sauf mention contraire. Un agent peut écouter ailleurs — un `snmpd` non
      // privilégié, un conteneur, ou un simulateur pendant une mise au point.
      port: Number(this.getSetting('port') ?? 161),
      version: (this.getSetting('version') as SnmpVersion) ?? 'v2c',
      liveInterval: Number(this.getSetting('live_interval') ?? LIVE_RHYTHM.defaultSeconds),
      detailInterval: Number(this.getSetting('detail_interval') ?? DETAIL_RHYTHM.defaultSeconds),
    };
  }

  /** La source reconnue au pairing. Absente sur un appareil appairé avant qu'elle existe. */
  private storedSource(): UpsSource | null {
    const stored = this.getStoreValue('source') as unknown;
    return typeof stored === 'string' ? (stored as UpsSource) : null;
  }

  private buildClient(): void {
    const { host, community, version, port } = this.readSettings();
    // Un timeout court : trois OID à 10 s ne supportent pas l'attente par défaut, et
    // c'est le compteur d'échecs — pas le socket — qui décide de l'indisponibilité.
    this.client = new SnmpClient({ host, community, version, port, timeout: 2_500, retries: 1 });
  }

  /**
   * Retrouve le dialecte de l'appareil quand le `store` ne le porte pas.
   *
   * Écriture persistante, donc **une seule fois** et sur changement : la détection ne
   * revient qu'après un échec de résolution, jamais à chaque relevé.
   */
  private async ensureReader(): Promise<UpsSourceReader | null> {
    if (this.reader !== null) return this.reader;

    const detection = await detectUpsSource(this.client);
    if (detection.reader === null) {
      this.log(`No dialect recognised — declined by: ${detection.declined.join(', ') || 'none'}`);
      return null;
    }

    this.reader = detection.reader;
    this.current.source = detection.reader.source;
    await this.setStoreValue('source', detection.reader.source).catch((e: Error) =>
      this.error(`Could not remember the source: ${e.message}`));
    this.log(`Source reconnue : ${detection.reader.source}`);
    return this.reader;
  }

  // -------------------------------------------------------------------------
  // Les deux rythmes
  // -------------------------------------------------------------------------

  /**
   * Un timeout chaîné plutôt qu'un intervalle : un onduleur lent ne peut pas empiler
   * des relevés derrière lui-même. `homey.setTimeout` plutôt que le global, parce que
   * Homey l'annule à l'arrêt de l'app — un timer nu continuerait de tirer contre un
   * appareil détruit.
   */
  private scheduleLive(): void {
    if (this.stopped) return;
    this.liveTimer = this.homey.setTimeout(() => {
      void this.pollLive().finally(() => this.scheduleLive());
    }, intervalMs(this.readSettings().liveInterval, LIVE_RHYTHM));
  }

  private scheduleDetail(): void {
    if (this.stopped) return;
    this.detailTimer = this.homey.setTimeout(() => {
      void this.pollDetail().finally(() => this.scheduleDetail());
    }, intervalMs(this.readSettings().detailInterval, DETAIL_RHYTHM));
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
   * Le groupe rapide (~10 s) : état secteur/batterie, autonomie, charge.
   *
   * C'est **le seul** qui alimente le suivi de contact. Le groupe lent n'a pas voix au
   * chapitre : à 5 min, il conclurait « injoignable » un quart d'heure après le fait, et
   * ses échecs se mêleraient à ceux du rapide dans le même compteur.
   */
  private async pollLive(): Promise<void> {
    await this.liveGate.run(async () => {
      let outcome: ContactOutcome;
      try {
        const reader = await this.ensureReader();
        if (reader === null) throw new Error('no SNMP dialect was recognised on this device');
        outcome = this.contact.succeeded(await reader.readLive(this.client));
      } catch (error) {
        outcome = this.contact.failed();
        this.logFailure(outcome, error);
      }
      await this.applyOutcome(outcome);
    });
  }

  /**
   * Le groupe lent (~5 min) : identité, tensions, température, seuils.
   *
   * Son échec ne rend **pas** l'appareil indisponible et ne touche pas au compteur : une
   * carte réseau qui bride les requêtes peut refuser ce groupe tout en répondant au
   * rapide, et c'est le rapide qui porte la valeur du produit.
   */
  private async pollDetail(): Promise<void> {
    await this.detailGate.run(async () => {
      try {
        const reader = await this.ensureReader();
        if (reader === null) return;
        const [identity, detail] = await Promise.all([
          reader.readIdentity(this.client),
          reader.readDetail(this.client),
        ]);
        this.mergeSlow(identity, detail);
        await this.writeValues();
      } catch (error) {
        this.log(`Slow poll got no answer (mains status keeps going): ${describe(error)}`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Écriture
  // -------------------------------------------------------------------------

  private mergeSlow(identity: UpsIdentity, detail: UpsDetail): void {
    this.current = { ...this.current, ...identity, ...detail };
  }

  private mergeLive(live: UpsLive): void {
    this.current = { ...this.current, ...live };
  }

  /**
   * Applique ce que le suivi de contact a décidé.
   *
   * L'ordre compte : **la disponibilité se règle avant l'écriture.** Athom documente qu'un
   * appareil indisponible voit « all capabilities and Flow actions » empêchées. Mesuré sur
   * un Homey Pro 2023, ce blocage ne porte en fait que sur le sens entrant — une écriture
   * de l'app pendant l'indisponibilité passe sans erreur et atteint bien le cœur. Nous ne
   * nous appuyons pas sur cette tolérance : elle n'est écrite nulle part, et le jour où
   * elle disparaît, c'est le premier relevé de chaque retour de contact qui serait perdu
   * en silence — celui-là même qui annonce que l'onduleur est revenu.
   *
   * `outcome.live === null` veut dire « n'écris rien » et non « écris du vide » : c'est
   * par là que l'état reste figé sur `battery` pendant qu'un NAS relais est éteint
   * (plan §3.8). Un `setCapabilityValue` de plus ici, et l'app annoncerait implicitement
   * que le courant est revenu.
   */
  private async applyOutcome(outcome: ContactOutcome): Promise<void> {
    if (outcome.contactLostDuringOutage) await this.fireContactLost();

    await this.applyAvailability(outcome);

    if (outcome.live !== null) {
      this.mergeLive(outcome.live);
      await this.writeValues();
      await this.fireTriggers(this.changes.observe(outcome.live));
    }
  }

  /**
   * Aligne la disponibilité Homey sur le verdict.
   *
   * L'appareil devient indisponible dans **les deux** pertes de contact, y compris
   * pendant une coupure : il l'est réellement. Le figeage du §3.8 porte sur ce qu'on
   * *affirme* — l'état publié — pas sur ce qu'on *prétend joindre*. Masquer
   * l'injoignabilité serait un second mensonge, et priverait l'utilisateur du seul
   * indice qui explique pourquoi les mesures ne bougent plus.
   */
  private async applyAvailability(outcome: ContactOutcome): Promise<void> {
    if (outcome.availability === 'available') {
      if (!this.getAvailable()) await this.setAvailable().catch(() => {});
      return;
    }
    if (outcome.reason === 'absorbing' || !this.getAvailable()) return;

    const message = outcome.reason === 'lost-during-outage'
      ? this.homey.__({
        en: 'No answer since the UPS went on battery — a relaying NAS switches itself off partway through an outage. The last known state is kept as is.',
        fr: 'Plus de réponse depuis le passage sur batterie — un NAS relais s’éteint de lui-même en cours de coupure. Le dernier état connu est conservé tel quel.',
        nl: 'Geen antwoord meer sinds de UPS op accu ging — een doorgevende NAS schakelt zichzelf halverwege een storing uit. De laatst bekende status blijft behouden.',
      })
      : this.homey.__({
        en: 'No SNMP answer. Check the address, the community and that SNMP is still enabled on the device.',
        fr: 'Aucune réponse SNMP. Vérifiez l’adresse, la communauté, et que le SNMP est toujours activé sur l’appareil.',
        nl: 'Geen SNMP-antwoord. Controleer het adres, de community en of SNMP nog is ingeschakeld op het apparaat.',
      });

    await this.setUnavailable(message).catch(() => {});
  }

  /**
   * Écrit le snapshot courant sur les capabilities que l'appareil porte **réellement**.
   *
   * Le jeu de capabilities est décidé au pairing et n'est jamais réduit ici :
   * `removeCapability` détruit l'historique Insights de façon irréversible, et une mesure
   * absente d'un cycle n'est pas une mesure disparue.
   */
  /**
   * Branche l'alignement des capabilities sur `this`.
   *
   * La logique vit dans `lib/ups/capability-sync.mts`, pas ici : le paquet `homey` est
   * la CLI et non le SDK runtime, donc rien de ce qui reste dans ce fichier n'est
   * vérifiable ailleurs que sur un vrai Homey. Même raison que pour `poll-engine`.
   */
  private async syncCapabilities(): Promise<void> {
    const result = await syncCapabilities(planCapabilities(this.current), {
      listCapabilities: () => this.getCapabilities(),
      addCapability: (id) => this.addCapability(id),
      setCapabilityOptions: (id, options) => this.setCapabilityOptions(id, options),
      setEnergy: (energy) => this.setEnergy(energy),
      log: (message) => this.log(message),
      error: (message) => this.error(message),
    });

    if (result.orphaned.length > 0 && !this.orphansLogged) {
      this.log(`Capabilities with no source, kept for their history: ${result.orphaned.join(', ')}`);
      this.orphansLogged = true;
    }
  }

  private async writeValues(): Promise<void> {
    await this.syncCapabilities();
    for (const { id, value } of capabilityValues(this.current, this.getCapabilities())) {
      await this.setCapabilityValue(id, value).catch((e: Error) =>
        this.error(`Could not write ${id}: ${e.message}`));
    }
    await this.writeAlarmText();
  }

  /**
   * Le texte d'alarme, rendu ici et nulle part ailleurs.
   *
   * `lib/` sait **ce qui** ne va pas et l'exprime en fragments ; il ne sait pas dans
   * quelle langue le dire. Le device est le seul à connaître celle de l'utilisateur,
   * d'où ce rendu au dernier moment. Ces libellés ont longtemps été écrits en français
   * en dur, dans une app publiée en trois langues.
   *
   * Écrit à **chaque** cycle, y compris quand il n'y a plus rien à signaler. Cette
   * capability n'apparaît qu'à la première alarme et n'est jamais retirée —
   * `removeCapability` détruirait son historique Insights — si bien que ne pas la
   * réécrire la laissait figée sur l'incident qui l'avait créée. Un texte d'alarme
   * périmé décrit un incident passé avec l'autorité du présent.
   *
   * Et l'absence d'alarme se **dit** au lieu de rester vide : un champ vide en permanence
   * se lit comme « cassé », pas comme « tout va bien ». C'est ce qu'a rapporté la
   * première installation réelle.
   */
  private async writeAlarmText(): Promise<void> {
    if (!this.getCapabilities().includes('ups_alarm_text')) return;

    const summary = this.current.alarmSummary;
    const text = summary === null
      ? this.homey.__({ en: 'No alarm', fr: 'Aucune alarme', nl: 'Geen alarm' })
      : renderAlarmSummary(summary, (part) => this.homey.__(part));

    await this.setCapabilityValue('ups_alarm_text', text).catch((e: Error) =>
      this.error(`Could not write ups_alarm_text: ${e.message}`));
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------

  /** Les mesures telles qu'un token les montre. Une absence s'affiche, elle ne s'invente pas. */
  private tokens(): { runtime: string; battery: string; load: string } {
    const { runtimeMinutes, batteryCharge, load } = this.current;
    return {
      runtime: runtimeMinutes === null ? UNKNOWN_TOKEN : `${runtimeMinutes} min`,
      battery: batteryCharge === null ? UNKNOWN_TOKEN : `${batteryCharge} %`,
      load: load === null ? UNKNOWN_TOKEN : `${load} %`,
    };
  }

  private async trigger(card: string, tokens: object = {}, state: object = {}): Promise<void> {
    await this.homey.flow
      .getDeviceTriggerCard(card)
      .trigger(this, tokens, state)
      .catch((e: Error) => this.error(`Trigger ${card}: ${e.message}`));
  }

  private async fireContactLost(): Promise<void> {
    const { runtime, battery } = this.tokens();
    await this.trigger('ups_contact_lost_during_outage', { runtime, battery });
  }

  private async fireTriggers(change: UpsChangeSet): Promise<void> {
    const { runtime, battery, load } = this.tokens();

    if (change.wentOnBattery) await this.trigger('ups_went_on_battery', { runtime, battery, load });
    if (change.mainsRestored) await this.trigger('ups_mains_restored', { runtime, battery });
    if (change.batteryLowRaised) await this.trigger('ups_battery_low', { runtime, battery });
    if (change.overloadRaised) await this.trigger('ups_overload', { load });
    if (change.replaceBatteryRaised) await this.trigger('ups_replace_battery');
    if (change.statusChanged) {
      await this.trigger('ups_status_changed', { status: change.status }, { status: change.status });
    }

    // Le seuil appartient à chaque Flow, pas à l'appareil : la carte part dès que
    // l'autonomie a baissé, et son `runListener` décide du franchissement à son propre
    // seuil. Sans quoi deux Flows réglés à 15 et 5 minutes exigeraient deux relevés.
    const { runtimeBefore: before, runtimeAfter: after } = change;
    if (before !== null && after !== null && after < before) {
      await this.trigger('ups_runtime_below', { runtime, battery }, change);
    }
  }

  // -------------------------------------------------------------------------
  // Ce que le driver appelle
  // -------------------------------------------------------------------------

  /** Relève le groupe rapide hors planning. Sert l'action Flow « relever maintenant ». */
  async refreshNow(): Promise<void> {
    await this.pollLive();
  }

  /** Sert la condition « est sur batterie », sans second aller-retour SNMP. */
  isOnBattery(): boolean {
    return this.current.alarms.onBattery;
  }

  /**
   * Sert les conditions numériques.
   *
   * Rend `null` quand la mesure est inconnue ; c'est au driver de refuser la condition
   * plutôt que de la traiter comme un zéro — une valeur non lue n'est pas une marge
   * confortable, ni une batterie vide.
   */
  measured(what: 'runtime' | 'battery'): number | null {
    return what === 'runtime' ? this.current.runtimeMinutes : this.current.batteryCharge;
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  private logFailure(outcome: ContactOutcome, error: unknown): void {
    const message = `${describe(error)} (failure ${outcome.failures})`;
    if (outcome.reason === 'absorbing') {
      this.log(`Poll got no answer, absorbed: ${message}`);
      return;
    }
    this.error(outcome.reason === 'lost-during-outage'
      ? `Contact lost during an outage, state frozen on "battery": ${message}`
      : `UPS unreachable: ${message}`);
  }

  override async onSettings({ changedKeys }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<void> {
    if (changedKeys.some((key) => CONNECTION_KEYS.includes(key))) {
      // Une adresse qui change peut désigner un **autre** appareil, parlant un autre
      // dialecte : le lecteur mémorisé ne vaut plus rien et la détection doit rejouer.
      // Une communauté ou une version qui change désigne toujours le même appareil ;
      // reconstruire le transport suffit, et refaire trois sondes ne coûterait que du
      // trafic. Dans les deux cas, les échecs d'avant et le relevé d'avant portaient sur
      // une conversation qui n'existe plus.
      const addressChanged = changedKeys.includes('host');
      this.homey.setTimeout(() => {
        this.buildClient();
        if (addressChanged) this.reader = null;
        this.contact.reset();
        this.changes.reset();
        void this.pollLive();
        void this.pollDetail();
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
