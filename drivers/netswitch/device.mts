/**
 * L'appareil Homey « port de switch ».
 *
 * **Un port = un appareil.** Un switch 48 ports ne fait pas un appareil à 48 capabilities :
 * Homey n'a aucune représentation utile de ça, et surtout les cartes de Flow d'`onoff` sont
 * générées **par appareil**, pas par sous-capability. Vingt-quatre ports pilotables sous un
 * seul appareil, ce serait vingt-quatre boutons sans une seule carte de Flow.
 *
 * Adaptateur, et rien d'autre : il branche des timers Homey sur `lib/netswitch/`, et écrit
 * sur des capabilities ce que `capability-map.mts` a décidé. Toute règle qui mérite un test
 * vit dans `lib/netswitch/`, jamais ici — `Homey.Device` ne s'instancie pas hors du runtime
 * Homey, et c'est exactement là que les trois apps précédentes se sont fait piéger.
 *
 * 🔴 **L'écriture est possible mais désactivée par défaut** (réglage `allow_control`).
 * Aucun chemin de ce fichier n'émet de SET sans être passé par `lib/netswitch/control.mts`,
 * qui refuse tant que le réglage est faux. Tant qu'il l'est, `onoff` n'est pas même
 * déclarée : il n'existe donc aucune carte de Flow capable de demander une écriture.
 *
 * 🔴 **Aucune écriture persistante par tick.** `syncCapabilities` est idempotent, et
 * `setStoreValue` n'apparaît que sur changement avéré de l'`ifIndex`. Le rythme rapide est
 * de 10 s, et N ports d'un même switch tapent le même agent : tout ce qui s'écrit par tick
 * s'écrit N fois par tick.
 */

import Homey from 'homey';

import { SnmpClient, SnmpUnreachableError, type SnmpVersion } from '../../lib/snmp/client.mjs';
import { syncCapabilities } from '../../lib/ups/capability-sync.mjs';
import { DETAIL_RHYTHM, LIVE_RHYTHM, PollGate, intervalMs } from '../../lib/device/rhythm.mjs';
import { planPortCapabilities, portCapabilityValues } from '../../lib/netswitch/capability-map.mjs';
import { PortContactTracker, type ContactOutcome } from '../../lib/netswitch/contact.mjs';
import { planPoePower, planPortPower, type ControlContext, type ControlDecision } from '../../lib/netswitch/control.mjs';
import type { PoePortRef } from '../../lib/netswitch/poe-mib.mjs';
import { UNKNOWN_LIVE, resolvePortIndex, type PortLive, type PortSnapshot } from '../../lib/netswitch/port.mjs';
import { readInventory, readPortIdentity, readPortLive, readPortSpeed } from '../../lib/netswitch/reader.mjs';
import { comparePortIdentity } from '../../lib/netswitch/identity-check.mjs';
import { NO_THROUGHPUT, throughputBetween, type TrafficSample } from '../../lib/netswitch/throughput.mjs';
import { writeVarbinds } from '../../lib/netswitch/writer.mjs';
import { LinkChangeDetector, type LinkChangeSet } from '../../lib/netswitch/link-change.mjs';

/** Ce que le pairing a écrit, et que l'utilisateur peut corriger ensuite. */
interface PortSettings {
  host: string;
  community: string;
  /**
   * Le port **UDP de l'agent SNMP**, sans le moindre rapport avec le port du switch que
   * cet appareil represente. Les deux notions se croisent partout dans ce driver : c'est
   * pour cela qu'il nomme la premiere `snmpPort` la ou l'ambiguite serait possible.
   */
  port: number;
  version: SnmpVersion;
  allowControl: boolean;
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

export default class NetSwitchPortDevice extends Homey.Device {
  private client!: SnmpClient;

  private liveTimer: NodeJS.Timeout | null = null;
  private detailTimer: NodeJS.Timeout | null = null;
  /** Une garde par groupe : le relevé lent ne doit jamais retarder le rapide. */
  private readonly liveGate = new PollGate();
  private readonly detailGate = new PollGate();

  private readonly contact = new PortContactTracker();
  private readonly changes = new LinkChangeDetector();

  /** Le relevé de compteurs précédent — la moitié d'une différence, donc d'un débit. */
  private lastSample: TrafficSample | null = null;

  /** N'annoncer les capabilities orphelines qu'une fois, pas à chaque relevé. */
  private orphansLogged = false;
  /** Homey refuse d'enregistrer un écouteur sur une capability absente. */
  private onoffBound = false;

  private current: PortSnapshot = {
    ifIndex: 0,
    name: null,
    description: null,
    alias: null,
    type: null,
    speedMbps: null,
    ...UNKNOWN_LIVE,
    ...NO_THROUGHPUT,
  };

  override async onInit(): Promise<void> {
    const store = this.storedPort();
    this.current = { ...this.current, ifIndex: store.ifIndex, name: store.ifName, description: store.ifDescr };
    this.buildClient();
    await this.bindOnOff();

    // Le premier relevé est lancé, pas attendu. Homey initialise les appareils en séquence,
    // et un switch 48 ports fait 48 appareils : bloquer ici sur un timeout SNMP retiendrait
    // tous les suivants, soit potentiellement plusieurs minutes de démarrage.
    void this.pollLive().finally(() => this.scheduleLive());
    void this.pollDetail().finally(() => this.scheduleDetail());
  }

  // -------------------------------------------------------------------------
  // Réglages et transport
  // -------------------------------------------------------------------------

  private readSettings(): PortSettings {
    return {
      host: String(this.getSetting('host') ?? ''),
      community: String(this.getSetting('community') ?? 'public'),
      port: Number(this.getSetting('port') ?? 161),
      version: (this.getSetting('version') as SnmpVersion) ?? 'v2c',
      // 🔴 Le défaut est `false`, et il l'est **ici aussi**. Un appareil appairé avant que
      // le réglage existe n'en porte aucune valeur : le lire comme vrai ouvrirait
      // l'écriture sur un parc entier sans que personne ne l'ait demandé.
      allowControl: this.getSetting('allow_control') === true,
      liveInterval: Number(this.getSetting('live_interval') ?? LIVE_RHYTHM.defaultSeconds),
      detailInterval: Number(this.getSetting('detail_interval') ?? DETAIL_RHYTHM.defaultSeconds),
    };
  }

  /** Ce que le pairing a mémorisé du port. */
  private storedPort(): { ifIndex: number; ifName: string | null; ifDescr: string | null; poe: PoePortRef | null } {
    const ifIndex = Number(this.getStoreValue('ifIndex') ?? 0);
    const group = this.getStoreValue('poeGroup') as unknown;
    const port = this.getStoreValue('poePort') as unknown;
    return {
      ifIndex: Number.isSafeInteger(ifIndex) ? ifIndex : 0,
      ifName: asTextOrNull(this.getStoreValue('ifName')),
      ifDescr: asTextOrNull(this.getStoreValue('ifDescr')),
      poe: typeof group === 'number' && typeof port === 'number' ? { group, port } : null,
    };
  }

  private buildClient(): void {
    const { host, community, port, version } = this.readSettings();
    // Un timeout court : N ports du même switch interrogent le même agent toutes les 10 s,
    // et c'est le compteur d'échecs — pas le socket — qui décide de l'indisponibilité.
    this.client = new SnmpClient({ host, community, version, port, timeout: 2_500, retries: 1 });
  }

  // -------------------------------------------------------------------------
  // Les deux rythmes
  // -------------------------------------------------------------------------

  /**
   * Un timeout chaîné plutôt qu'un intervalle : un switch lent ne peut pas empiler des
   * relevés derrière lui-même. `homey.setTimeout` plutôt que le global, parce que Homey
   * l'annule à l'arrêt de l'app — un timer nu continuerait de tirer contre un appareil
   * détruit.
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

  /** Le groupe rapide (~10 s) : lien, erreurs, compteurs de trafic, état PoE. */
  private async pollLive(): Promise<void> {
    await this.liveGate.run(async () => {
      const store = this.storedPort();
      let outcome: ContactOutcome;
      try {
        if (this.current.ifIndex <= 0) throw new Error('no port index is known for this device');
        outcome = this.contact.succeeded(await readPortLive(this.client, this.current.ifIndex, this.poeRef() ?? store.poe));
      } catch (error) {
        outcome = this.contact.failed();
        this.logFailure(outcome, error);
      }
      await this.applyOutcome(outcome);
    });
  }

  /**
   * Le groupe lent (~5 min) : le débit négocié, et surtout le **réalignement de l'index**.
   *
   * 🔴 C'est la raison d'être de ce groupe. Un switch qui redémarre peut renuméroter ses
   * interfaces : sans ce relevé, l'appareil continuerait de publier les mesures d'un autre
   * port — les courbes ne s'arrêtent pas, elles deviennent fausses, et rien ne le signale.
   *
   * Son échec ne rend **pas** l'appareil indisponible et ne touche pas au compteur : c'est
   * le relevé rapide qui porte la valeur du produit, et un `walk` complet est exactement ce
   * qu'un agent bridé refuse en premier.
   */
  private async pollDetail(): Promise<void> {
    await this.detailGate.run(async () => {
      try {
        const inventory = await readInventory(this.client);
        await this.realignIndex(inventory.ports);

        if (this.current.ifIndex > 0) {
          this.current.speedMbps = inventory.speeds.get(this.current.ifIndex)
            ?? await readPortSpeed(this.client, this.current.ifIndex);
          const poe = inventory.poe?.byIfIndex.get(this.current.ifIndex) ?? null;
          await this.rememberPoe(poe);
        }
        await this.writeValues();
      } catch (error) {
        this.log(`Slow poll got no answer (link status keeps going): ${describe(error)}`);
      }
    });
  }

  /**
   * Réaligne l'index sur l'inventaire courant, et le mémorise **seulement s'il a changé**.
   *
   * L'écriture persistante est conditionnelle pour la raison de l'en-tête : ce relevé
   * tourne sur chacun des N appareils d'un même switch, et une écriture inconditionnelle
   * ferait N écritures de store toutes les cinq minutes pour rien.
   */
  private async realignIndex(ports: readonly { ifIndex: number; name: string | null; description: string | null }[]): Promise<void> {
    const store = this.storedPort();
    const resolved = resolvePortIndex(
      ports.map((port) => ({ ...port, alias: null, type: null })),
      { ifIndex: store.ifIndex, name: store.ifName, description: store.ifDescr },
    );

    if (resolved === null) {
      // Le port n'existe plus sous ce nom. Ne pas retomber sur l'index mémorisé : mieux
      // vaut un appareil qui se dit indisponible qu'un appareil qui publie le voisin.
      this.current.ifIndex = 0;
      await this.setUnavailable(this.homey.__({
        en: 'This port is no longer listed by the switch under the name it was added with. Nothing is being read, rather than reading a different port.',
        fr: 'Ce port n’est plus listé par le switch sous le nom avec lequel il a été ajouté. Rien n’est relevé, plutôt que de relever un autre port.',
        nl: 'Deze poort staat niet meer in de lijst van de switch onder de naam waarmee hij is toegevoegd. Er wordt niets uitgelezen in plaats van een andere poort.',
      })).catch(() => {});
      return;
    }

    if (resolved === this.current.ifIndex) return;

    this.log(`The port changed index: ${this.current.ifIndex} -> ${resolved}`);
    this.current.ifIndex = resolved;
    if (resolved !== store.ifIndex) {
      await this.setStoreValue('ifIndex', resolved).catch((e: Error) =>
        this.error(`Could not remember the index: ${e.message}`));
    }
  }

  /** La prise PoE mémorisée, réécrite seulement quand la correspondance a changé. */
  private poeRef(): PoePortRef | null {
    return this.current.poe?.ref ?? null;
  }

  private async rememberPoe(poe: PoePortRef | null): Promise<void> {
    const store = this.storedPort();
    const same = (store.poe?.group ?? null) === (poe?.group ?? null)
      && (store.poe?.port ?? null) === (poe?.port ?? null);
    if (same) return;

    await this.setStoreValue('poeGroup', poe?.group ?? null).catch(() => {});
    await this.setStoreValue('poePort', poe?.port ?? null).catch(() => {});
    this.log(poe === null
      ? 'No PoE match for this port — PoE readings are no longer taken'
      : `Correspondance PoE : groupe ${poe.group}, prise ${poe.port}`);
  }

  // -------------------------------------------------------------------------
  // Écriture des capabilities
  // -------------------------------------------------------------------------

  /**
   * Applique ce que le suivi de contact a décidé.
   *
   * L'ordre compte : **la disponibilité se règle avant l'écriture.** Athom documente qu'un
   * appareil indisponible voit « all capabilities and Flow actions » empêchées. Mesuré sur
   * un Homey Pro 2023, ce blocage ne porte en fait que sur le sens entrant — une écriture
   * de l'app pendant l'indisponibilité passe sans erreur et atteint bien le cœur. Nous ne
   * nous appuyons pas sur cette tolérance : elle n'est écrite nulle part, et le jour où
   * elle disparaît, c'est le premier relevé de chaque retour de contact qui serait perdu
   * en silence — celui-là même qui annonce que la machine est revenue.
   *
   * `outcome.live === null` veut dire « n'écris rien » et non « écris du vide » : un paquet
   * UDP perdu ne doit pas faire tomber le lien, ni déclencher les Flows de coupure.
   */
  private async applyOutcome(outcome: ContactOutcome): Promise<void> {
    await this.applyAvailability(outcome);

    if (outcome.live !== null) {
      this.mergeLive(outcome.live);
      await this.writeValues();
      await this.fireTriggers(this.changes.observe(this.current));
    }
  }

  /**
   * Fusionne un relevé, et calcule le débit **avant** d'écraser l'échantillon précédent.
   *
   * L'ordre est le piège : le débit se calcule entre l'ancien échantillon et le nouveau.
   * Mémoriser le nouveau d'abord donnerait une différence nulle, donc un débit de zéro à
   * chaque relevé — une valeur crédible, constante, et fausse.
   */
  private mergeLive(live: PortLive): void {
    const sample: TrafficSample = {
      octetsIn: live.octetsIn,
      octetsOut: live.octetsOut,
      octetsWidth: live.octetsWidth,
      discontinuityTicks: live.discontinuityTicks,
      atMs: Date.now(),
    };
    // Le débit négocié n'entre dans le calcul que pour juger un recul de compteur
    // 32 bits — il vient du rythme lent, donc il peut encore être `null` aux premiers
    // relevés, et le repli 32 bits se tait alors plutôt que de deviner.
    const rates = throughputBetween(this.lastSample, sample, this.current.speedMbps);
    this.lastSample = sample;
    this.current = { ...this.current, ...live, ...rates };
  }

  private async applyAvailability(outcome: ContactOutcome): Promise<void> {
    if (outcome.availability === 'available') {
      if (!this.getAvailable() && this.current.ifIndex > 0) await this.setAvailable().catch(() => {});
      return;
    }
    if (outcome.absorbing || !this.getAvailable()) return;

    await this.setUnavailable(this.homey.__({
      en: 'No SNMP answer from the switch. Check the address, the community and that SNMP is still enabled on it.',
      fr: 'Aucune réponse SNMP du switch. Vérifiez l’adresse, la communauté, et que le SNMP y est toujours activé.',
      nl: 'Geen SNMP-antwoord van de switch. Controleer het adres, de community en of SNMP nog is ingeschakeld.',
    })).catch(() => {});
  }

  /**
   * Branche l'alignement des capabilities sur `this`.
   *
   * 🔴 C'est **le** branchement que la revue a trouvé manquant sur l'onduleur : le mapping
   * existait, était testé, et n'était appelé de nulle part — douze mesures sur treize
   * étaient calculées toutes les dix secondes puis jetées. Ici, `writeValues()` l'appelle
   * en premier, et `test/netswitch/capability-map.test.mts` vérifie que le plan d'un port
   * complet dépasse la seule capability du `driver.compose.json`.
   */
  private async syncCapabilities(): Promise<void> {
    const plan = planPortCapabilities(this.current, { allowControl: this.readSettings().allowControl });
    const result = await syncCapabilities(plan, {
      listCapabilities: () => this.getCapabilities(),
      addCapability: (id) => this.addCapability(id),
      setCapabilityOptions: (id, options) => this.setCapabilityOptions(id, options),
      setEnergy: (energy) => this.setEnergy(energy),
      log: (message) => this.log(message),
      error: (message) => this.error(message),
    });

    if (result.added.includes('onoff')) await this.bindOnOff();

    if (result.orphaned.length > 0 && !this.orphansLogged) {
      this.log(`Capabilities with no source, kept for their history: ${result.orphaned.join(', ')}`);
      this.orphansLogged = true;
    }
  }

  private async writeValues(): Promise<void> {
    await this.syncCapabilities();
    for (const { id, value } of portCapabilityValues(this.current, this.getCapabilities())) {
      await this.setCapabilityValue(id, value).catch((e: Error) =>
        this.error(`Could not write ${id}: ${e.message}`));
    }
  }

  // -------------------------------------------------------------------------
  // L'écriture, et son garde-fou
  // -------------------------------------------------------------------------

  private controlContext(): ControlContext {
    const store = this.storedPort();
    return {
      allowControl: this.readSettings().allowControl,
      ifIndex: this.current.ifIndex > 0 ? this.current.ifIndex : null,
      poe: this.poeRef() ?? store.poe,
    };
  }

  /**
   * Enregistre l'écouteur d'`onoff`, et seulement quand la capability existe.
   *
   * Homey lève sur un écouteur posé sur une capability absente. Comme `onoff` n'apparaît
   * qu'après que l'utilisateur a coché `allow_control`, l'enregistrement doit pouvoir
   * arriver **après** `onInit` — d'où l'appel depuis `syncCapabilities()`.
   */
  private async bindOnOff(): Promise<void> {
    if (this.onoffBound || !this.getCapabilities().includes('onoff')) return;
    this.onoffBound = true;
    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.applyDecision(planPortPower(this.controlContext(), value === true), `port ${value ? 'up' : 'down'}`);
    });
  }

  /** Sert la carte de Flow « allumer/éteindre le port », qui existe même sans `onoff`. */
  async setPortPower(on: boolean): Promise<void> {
    await this.applyDecision(planPortPower(this.controlContext(), on), `port ${on ? 'up' : 'down'}`);
    if (this.getCapabilities().includes('onoff')) {
      await this.setCapabilityValue('onoff', on).catch(() => {});
    }
  }

  /** Sert la carte de Flow « couper/rétablir le PoE ». */
  async setPoePower(on: boolean): Promise<void> {
    await this.applyDecision(planPoePower(this.controlContext(), on), `poe ${on ? 'on' : 'off'}`);
  }

  /**
   * Exécute une décision, ou lève un message que la carte de Flow montrera telle quelle.
   *
   * 🔴 Le refus doit **dire quoi activer**. Un « échec » nu sur une carte de Flow envoie
   * l'utilisateur chercher un problème de réseau alors que la réponse est une case à
   * cocher dans les réglages de l'appareil.
   */
  private async applyDecision(decision: ControlDecision, what: string): Promise<void> {
    if (!decision.allowed) throw new Error(this.refusal(decision.reason));

    // 🔴 Vise-t-on encore le port qu'on croit viser ? L'index n'est réaligné qu'au relevé
    // lent — 300 s par défaut, jusqu'à 24 h — et une renumérotation entre-temps ferait
    // couper le **mauvais port**. Ni le transport ni l'agent n'attraperaient ça : une
    // écriture bien formée sur un OID valide réussit et remonte comme un succès.
    await this.refusePortIfRenumbered();

    const { host, community, port, version } = this.readSettings();
    this.log(`Write requested: ${what}`);
    // Le port compte **aussi** en ecriture : un agent joignable seulement ailleurs qu'en
    // 161 accepterait la lecture et verrait partir ses commandes dans le vide.
    await writeVarbinds({ host, community, port, version }, decision.writes);

    // Le relevé rapide confirmera — ou infirmera — dans la seconde qui suit. C'est lui qui
    // fait foi : un SET accepté par l'agent n'est pas encore un port qui a changé d'état.
    void this.pollLive();
  }

  /**
   * Relit l'identité du port juste avant d'écrire, et refuse si elle a changé.
   *
   * Un aller-retour de plus, sur une action déclenchée à la main : le coût est nul devant
   * la conséquence qu'il évite. Une lecture qui échoue ne bloque pas — l'agent est
   * peut-être momentanément muet, et refuser sur cette base priverait de la commande un
   * appareil qui n'a rien fait de mal ; le doute ne profite au refus que lorsqu'on a une
   * **preuve** de divergence.
   */
  private async refusePortIfRenumbered(): Promise<void> {
    const store = this.storedPort();
    if (this.current.ifIndex <= 0) return;

    let live: { ifName: string | null; ifDescr: string | null };
    try {
      live = await readPortIdentity(this.client, this.current.ifIndex);
    } catch {
      return;
    }

    if (comparePortIdentity(store, live) !== 'changed') return;

    this.error(
      `Write refused: index ${this.current.ifIndex} no longer points at "`
      + `${store.ifName ?? store.ifDescr ?? '?'}" but at "${live.ifName ?? live.ifDescr ?? '?'}"`,
    );
    throw new Error(this.homey.__({
      en: 'This switch has renumbered its ports since this device was added, so the command would have hit a different port. Nothing was sent. It will realign on its own within a few minutes — try again then.',
      fr: 'Ce switch a renuméroté ses ports depuis l’ajout de cet appareil : la commande serait partie sur un autre port. Rien n’a été envoyé. Le réalignement se fait tout seul en quelques minutes — réessayez ensuite.',
      nl: 'Deze switch heeft zijn poorten hernummerd sinds dit apparaat werd toegevoegd, dus de opdracht zou een andere poort hebben geraakt. Er is niets verzonden. Hij lijnt zichzelf binnen enkele minuten weer uit — probeer het dan opnieuw.',
    }));
  }

  private refusal(reason: 'control-disabled' | 'no-port' | 'no-poe'): string {
    if (reason === 'control-disabled') {
      return this.homey.__({
        en: 'Switching ports is off for this device. Turn on "Allow switching this port" in the device settings first — and read the warning there before you do.',
        fr: 'La commande des ports est désactivée sur cet appareil. Activez d’abord « Autoriser la commande de ce port » dans les réglages de l’appareil — et lisez l’avertissement qui s’y trouve.',
        nl: 'Poorten schakelen staat uit voor dit apparaat. Zet eerst "Schakelen van deze poort toestaan" aan in de apparaatinstellingen — en lees daar eerst de waarschuwing.',
      });
    }
    if (reason === 'no-poe') {
      return this.homey.__({
        en: 'This port has no PoE socket the app could match reliably, so it will not send a PoE command it cannot aim.',
        fr: 'Aucune prise PoE n’a pu être reliée à ce port de façon sûre : l’app n’envoie pas une commande PoE qu’elle ne sait pas viser.',
        nl: 'Er kon geen PoE-aansluiting betrouwbaar aan deze poort worden gekoppeld, dus wordt er geen PoE-opdracht verstuurd.',
      });
    }
    return this.homey.__({
      en: 'The switch no longer lists this port under the name it was added with, so nothing is being sent to it.',
      fr: 'Le switch ne liste plus ce port sous le nom avec lequel il a été ajouté : rien ne lui est envoyé.',
      nl: 'De switch toont deze poort niet meer onder de naam waarmee hij is toegevoegd; er wordt niets verstuurd.',
    });
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------

  /** Les mesures telles qu'un token les montre. Une absence s'affiche, elle ne s'invente pas. */
  private tokens(): { port: string; speed: string; rx: string; tx: string } {
    const { speedMbps, rxMbps, txMbps } = this.current;
    return {
      port: this.current.name ?? this.current.description ?? String(this.current.ifIndex),
      speed: speedMbps === null ? UNKNOWN_TOKEN : `${speedMbps} Mbit/s`,
      rx: rxMbps === null ? UNKNOWN_TOKEN : `${rxMbps} Mbit/s`,
      tx: txMbps === null ? UNKNOWN_TOKEN : `${txMbps} Mbit/s`,
    };
  }

  private async trigger(card: string, tokens: object = {}, state: object = {}): Promise<void> {
    await this.homey.flow
      .getDeviceTriggerCard(card)
      .trigger(this, tokens, state)
      .catch((e: Error) => this.error(`Trigger ${card}: ${e.message}`));
  }

  private async fireTriggers(change: LinkChangeSet): Promise<void> {
    const tokens = this.tokens();
    if (change.cameUp) await this.trigger('netswitch_port_up', tokens);
    if (change.wentDown) await this.trigger('netswitch_port_down', tokens);
    if (change.linkChanged) {
      await this.trigger('netswitch_link_changed', { ...tokens, state: change.link }, { state: change.link });
    }
    if (change.poeFaultRaised) await this.trigger('netswitch_poe_fault', tokens);
  }

  // -------------------------------------------------------------------------
  // Ce que le driver appelle
  // -------------------------------------------------------------------------

  /** Relève le groupe rapide hors planning. Sert l'action Flow « relever maintenant ». */
  async refreshNow(): Promise<void> {
    await this.pollLive();
  }

  /** Sert la condition « le lien est actif », sans second aller-retour SNMP. */
  isLinkUp(): boolean {
    return this.current.link === 'up';
  }

  /** Sert la condition « le PoE alimente ». Faux quand aucune prise n'est reliée. */
  isPoeDelivering(): boolean {
    return this.current.poe?.status === 'delivering';
  }

  /** Sert les conditions numériques. `null` quand la mesure est inconnue — au driver de refuser. */
  measured(what: 'speed' | 'rx' | 'tx'): number | null {
    if (what === 'speed') return this.current.speedMbps;
    return what === 'rx' ? this.current.rxMbps : this.current.txMbps;
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  private logFailure(outcome: ContactOutcome, error: unknown): void {
    const message = `${describe(error)} (failure ${outcome.failures})`;
    if (outcome.absorbing) {
      this.log(`Poll got no answer, absorbed: ${message}`);
      return;
    }
    this.error(`Switch unreachable: ${message}`);
  }

  override async onSettings({ changedKeys }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<void> {
    if (changedKeys.some((key) => CONNECTION_KEYS.includes(key))) {
      this.homey.setTimeout(() => {
        this.buildClient();
        this.contact.reset();
        this.changes.reset();
        // Les compteurs d'avant portaient sur un autre agent : garder l'échantillon
        // produirait un débit calculé entre deux appareils différents.
        this.lastSample = null;
        void this.pollLive();
        void this.pollDetail();
      }, SETTINGS_SETTLE_MS);
    }

    if (changedKeys.includes('allow_control')) {
      // Le seul réglage qui ajoute une capability après coup. `syncCapabilities` n'en
      // retire jamais : décocher la case laisse `onoff` en place — l'historique Insights
      // est irremplaçable — mais `control.mts` refuse alors toute écriture, ce qui est la
      // garantie qui compte.
      this.homey.setTimeout(() => { void this.writeValues(); }, SETTINGS_SETTLE_MS);
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

/** Une valeur de `store` en texte, ou `null`. Jamais une chaîne vide. */
function asTextOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}
