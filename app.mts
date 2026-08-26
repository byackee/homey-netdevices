import 'source-map-support/register.js';
import net from 'node:net';
import Homey from 'homey';

import { SnmpClient, negotiateVersion, type SnmpReader, type SnmpVersion } from './lib/snmp/client.mjs';
import { scanSubnet, subnetOf } from './lib/snmp/scan.mjs';
import { trace } from './lib/snmp/trace.mjs';
import { detectUpsSource } from './lib/ups/sources.mjs';
import type { UpsIdentity, UpsSource } from './lib/ups/snapshot.mjs';

/**
 * Where `GET /trace` reads from.
 *
 * The ring buffer itself belongs to the SNMP core (`lib/snmp/trace.mts`); the
 * app only holds a reference to it. That indirection is deliberate: the buffer
 * has to be reachable from the API before any driver exists, and the API must
 * not have to change when the producer does.
 */
export interface TraceSource {
  /** Oldest entry first, already timestamped and formatted. */
  lines(): readonly string[];
}

/** `sysDescr.0` — every SNMP agent has it, so it is the cheapest "are you there?". */
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
/** `sysName.0` — what the device calls itself; used to name a candidate. */
const SYS_NAME = '1.3.6.1.2.1.1.5.0';
/**
 * `ifNumber.0` — how many network interfaces the agent declares.
 *
 * 🔴 Read during the sweep, in the same packet, because it is the cheapest thing that
 * separates a switch from everything else that speaks SNMP. Found the hard way: the
 * Epson printer on the test network has `ifNumber = 1` and was being offered as a
 * switch, because the only heuristic that would have refused it ran one step too late.
 */
const IF_NUMBER = '1.3.6.1.2.1.2.1.0';

/**
 * Ce qu'une sonde d'adresse s'autorise en lectures SNMP, négociation déduite.
 *
 * Un appel à l'API d'une app est coupé à dix secondes. On en garde deux de marge pour
 * la négociation de version et le repli TCP, et on plafonne le reste.
 */
const PROBE_BUDGET_MS = 6_000;

/**
 * One probe during a sweep: a single packet, no retry.
 *
 * A device slower than this is not idle, and 254 addresses at any longer a
 * timeout push the sweep well past the sixteen seconds it already costs.
 */
const SWEEP_TIMEOUT_MS = 1_500;

/**
 * Timeouts for a single-address probe, which runs inside an API call.
 *
 * A Homey API call is cut off after ten seconds. The worst path here is: version
 * negotiation (two versions), then up to three dialect probes, then one identity
 * read — which is why each budget is small and none of them retries.
 */
const PROBE_NEGOTIATE_MS = 2_000;
const PROBE_READ_MS = 1_200;

/** Ports a live host answers or refuses; either one proves it is there. */
const REACHABILITY_PORTS = [80, 443, 22, 5000] as const;
/** Long enough for a LAN round trip, short enough to stay invisible in an API call. */
const REACHABILITY_TIMEOUT_MS = 600;

/** How much of `sysDescr` is worth keeping. Some agents answer with a paragraph. */
const DESCRIPTION_LIMIT = 120;

/** One address the sweep identified. */
export interface ScanFinding {
  host: string;
  /** The dialect that answered, or `null` when the device speaks SNMP but no UPS MIB. */
  source: UpsSource | null;
  /** `sysDescr`, truncated — this is what tells the user what the address actually is. */
  description: string | null;
  /** `sysName`, when the agent publishes one. */
  name: string | null;
  /**
   * `ifNumber` — interfaces declared, or `null` when the agent does not say.
   *
   * A switch has eight, twenty-four or forty-eight. A printer, a UPS card or a NAS has
   * one or two. `null` is not zero: an agent that stays silent must not be ruled out.
   */
  interfaces: number | null;
  model: string | null;
  manufacturer: string | null;
  serial: string | null;
}

/** A sweep in progress, or the last one that finished. */
export interface ScanState {
  running: boolean;
  subnet: string | null;
  error: string | null;
  /** Addresses probed so far, and how many there are — the pairing view's progress bar. */
  probed: number;
  total: number;
  /** Devices that answered a UPS dialect. */
  found: ScanFinding[];
  /**
   * Devices that answered SNMP but speak no UPS MIB.
   *
   * Kept, and shown, because "three devices answered SNMP and none is a UPS" and
   * "nothing answered at all" send the user to two completely different places:
   * the first means SNMP works and the UPS card is off, the second means SNMP is
   * off everywhere — or the sweep is on the wrong subnet.
   */
  others: ScanFinding[];
}

/** What a single address turned out to be. */
export type ProbeOutcome =
  /** A UPS dialect answered. */
  | 'ups'
  /** SNMP answered, but no UPS MIB did. */
  | 'snmp'
  /** Something is at that address, but it says nothing over SNMP. */
  | 'reachable'
  /** Nothing answered, on any port or version. */
  | 'silent';

/** The full result of asking one address, ready to be shown or adopted. */
export interface AddressProbe {
  host: string;
  outcome: ProbeOutcome;
  /** The version that answered, so pairing writes the one that actually works. */
  version: SnmpVersion | null;
  source: UpsSource | null;
  description: string | null;
  name: string | null;
  identity: UpsIdentity | null;
}

/**
 * The app owns nothing a device owns — each device polls itself. What it does
 * own is the trace buffer and the subnet sweep.
 *
 * The trace buffer, because an app installed with `homey app install` has no
 * readable log anywhere: Developer Tools lists App Store submissions only, and
 * the CLI has no log command. On the three apps that came before this one, that
 * buffer is what located every single failure, so it is wired from the first
 * commit rather than after the first outage.
 *
 * The sweep, because it belongs to no single driver (plan §3.7): a pairing
 * session is bound to the driver it starts from and cannot create a device on
 * another one, so the *first* driver paired pays for the sweep and every later
 * one reads the cached result and filters it to its own class. It also cannot
 * live inside an API endpoint, since a call is cut off at ten seconds and a /24
 * takes around sixteen — it is started, then polled.
 */
export default class NetDevicesApp extends Homey.App {
  private traceSource: TraceSource | null = null;

  private scan: ScanState = {
    running: false,
    subnet: null,
    error: null,
    probed: 0,
    total: 0,
    found: [],
    others: [],
  };

  override async onInit(): Promise<void> {
    // The shared buffer exists whether or not anyone reads it; without this line
    // `GET /trace` answers `wired: false` forever and the one instrument that
    // located every past failure is invisible from the settings page.
    this.setTraceSource({
      lines: () => {
        const text = trace.toText();
        return text === '' ? [] : text.split('\n');
      },
    });
    // Pas le nom de l'app : Homey préfixe déjà chaque ligne de journal de l'id de
    // l'app, et le nom recopié ici est ce qui a survécu au renommage de la 1.0.11 —
    // le journal a continué d'annoncer « SNMP - Network Devices » après que le
    // manifeste eut cessé de le faire. Une copie d'un nom finit toujours par mentir.
    this.log('App initialised');
  }

  /** Called once by whoever creates the buffer, during its own init. */
  setTraceSource(source: TraceSource): void {
    this.traceSource = source;
  }

  /**
   * Whether a buffer has been attached at all.
   *
   * `GET /trace` reports this separately from the lines, because "nothing was
   * traced" and "nothing is tracing" look identical from an empty array — and
   * telling those two apart is the whole reason the endpoint exists.
   */
  hasTraceSource(): boolean {
    return this.traceSource !== null;
  }

  /** The buffer's contents, or an empty list while nothing is attached. */
  getTrace(): readonly string[] {
    return this.traceSource?.lines() ?? [];
  }

  // ---------------------------------------------------------------------------
  // The shared subnet sweep
  // ---------------------------------------------------------------------------

  /** The current sweep state, safe to read at any time. */
  getScanState(): ScanState {
    return { ...this.scan, found: [...this.scan.found], others: [...this.scan.others] };
  }

  /**
   * Starts a sweep unless one is already running, and returns immediately.
   *
   * A caller arriving mid-sweep gets the state as it stands — partial results
   * included — rather than starting a second sweep on top of the first. That is
   * not a nicety: two sweeps of the same /24 double the socket pressure on a
   * Homey that only has so many file descriptors.
   *
   * @param skip      addresses already paired, so the list only offers something new
   * @param community the SNMP community to sweep with; a device answering on a
   *                  different one is invisible to the sweep, which is why the
   *                  pairing view lets the user probe an address by hand
   */
  async startScan(skip: ReadonlySet<string> = new Set(), community = 'public'): Promise<ScanState> {
    if (this.scan.running) return this.getScanState();

    // 🔴 Le drapeau se pose **avant** le premier `await`, et non après.
    //
    // Il vivait plus bas, une fois le sous-réseau connu. Entre le test ci-dessus et sa
    // pose, `getLocalAddress()` rendait la main : deux déclencheurs quasi simultanés — la
    // page de réglages qui lance un balayage pendant qu'une vue de pairing en demande un,
    // ou simplement deux vues ouvertes — passaient tous deux le test et démarraient deux
    // parcours. Quarante-huit sockets UDP au lieu de vingt-quatre, et le second
    // écrasait l'accumulateur du premier : résultats partiels perdus, progression
    // incohérente. C'est exactement ce que le commentaire ci-dessus dit empêcher, et pour
    // la raison qu'il donne.
    //
    // Poser le drapeau tôt oblige à le relâcher sur tous les chemins de sortie. Le
    // sous-réseau indéterminable le fait lui-même plus bas, en réécrivant l'état complet ;
    // le `catch` couvre ce qui lèverait avant. Le succès, lui, le garde levé jusqu'à ce
    // que le parcours se termine.
    this.scan = { ...this.scan, running: true };

    try {
      return await this.beginScan(skip, community);
    } catch (error) {
      this.scan = { ...this.scan, running: false };
      throw error;
    }
  }

  /** Le corps du balayage, une fois la course refermée par {@link startScan}. */
  private async beginScan(skip: ReadonlySet<string>, community: string): Promise<ScanState> {
    const localAddress = await this.homey.cloud.getLocalAddress().catch(() => '');
    const subnet = subnetOf(String(localAddress));

    if (subnet === null) {
      trace.error('scan', `cannot work out a subnet from "${String(localAddress)}"`);
      this.scan = {
        running: false,
        subnet: null,
        error: 'unknown-subnet',
        probed: 0,
        total: 0,
        found: [],
        others: [],
      };
      return this.getScanState();
    }

    const skipped = [...skip].filter((host) => host.startsWith(`${subnet}.`)).length;

    // Results accumulate in place so a poll arriving mid-sweep sees partial
    // results instead of an empty list.
    this.scan = {
      running: true,
      subnet,
      error: null,
      probed: 0,
      total: Math.max(0, 254 - skipped),
      found: [],
      others: [],
    };
    this.log(`Sweeping ${subnet}.0/24 for UPS devices`);

    void scanSubnet(subnet, (client) => this.sweepProbe(client), {
      skip,
      community,
      timeout: SWEEP_TIMEOUT_MS,
      onFound: (finding) => {
        if (finding.source === null) this.scan.others.push(finding);
        else this.scan.found.push(finding);
      },
    })
      .then(() => {
        trace.info('scan', 'sweep finished', {
          ups: this.scan.found.length,
          other: this.scan.others.length,
        });
      })
      .catch((error: Error) => {
        this.error(`Sweep failed: ${error.message}`);
        trace.error('scan', 'sweep aborted', error);
        this.scan.error = error.message;
      })
      .finally(() => {
        // The counter is what the progress bar reads; a sweep that ended has to
        // read as complete even when some addresses threw before being counted.
        this.scan.probed = this.scan.total;
        this.scan.running = false;
      });

    return this.getScanState();
  }

  /**
   * The question asked at every address of the sweep.
   *
   * `sysDescr` first, on its own: a dead address then costs exactly one timed-out
   * packet instead of three. Only an address that answered is worth asking which
   * UPS dialect it speaks — and an address that answers SNMP without speaking any
   * of them is *kept*, because that is the diagnosis the user needs.
   */
  private async sweepProbe(client: SnmpReader): Promise<ScanFinding | null> {
    // Counted here rather than in the caller because `scanSubnet` owns the worker
    // pool and reports nothing per address; this callback is the only per-address
    // hook there is.
    this.scan.probed += 1;

    let system: Map<string, string | number | Buffer | null>;
    try {
      system = await client.get([SYS_DESCR, SYS_NAME, IF_NUMBER]);
    } catch {
      return null;
    }

    const description = asText(system.get(SYS_DESCR));
    const name = asText(system.get(SYS_NAME));
    if (description === null && name === null) return null;

    // `null` quand l'agent ne publie pas `ifNumber` : « il ne le dit pas » n'est pas
    // « il n'en a aucune », et confondre les deux exclurait un switch silencieux.
    const declared = system.get(IF_NUMBER);
    const interfaces = typeof declared === 'number' && Number.isFinite(declared) && declared >= 0
      ? declared
      : null;

    const base: ScanFinding = {
      host: client.host,
      source: null,
      description,
      name,
      interfaces,
      model: null,
      manufacturer: null,
      serial: null,
    };

    let detection;
    try {
      detection = await detectUpsSource(client);
    } catch {
      // It answered `sysDescr` and then stopped answering. Reporting it as an
      // ordinary SNMP device is truthful and still tells the user it is there.
      return base;
    }

    if (detection.reader === null) return base;

    let identity: UpsIdentity = { model: null, manufacturer: null, serial: null };
    try {
      identity = await detection.reader.readIdentity(client);
    } catch {
      // The dialect answered its probe; a failed identity read costs a nicer name,
      // not the finding itself.
    }

    trace.info('scan', `UPS recognised at ${client.host}`, {
      source: detection.reader.source,
      model: identity.model,
    });

    return { ...base, source: detection.reader.source, ...identity };
  }

  // ---------------------------------------------------------------------------
  // Asking one address
  // ---------------------------------------------------------------------------

  /**
   * Asks a single address what it is, and — when it says nothing — whether it is
   * even there.
   *
   * 🔴 That last distinction is the point of this whole method. "No answer" and
   * "answers, but not over SNMP" look identical from an SNMP client, and they
   * send the user to two different places: one to check the address, the other to
   * go and *switch SNMP on* — which is off by default on recent APC NMC firmware,
   * and is exactly why the APC thread on the Homey forum has been stuck on
   * "no new devices found" since 2018 (plan §3.1 bis).
   *
   * The whole path is budgeted to stay inside the ten seconds an API call gets:
   * negotiation is capped at two short attempts, dialect probes at three shorter
   * ones, and the TCP reachability check only runs when SNMP already gave up.
   *
   * 🔴 That accounting was in *calls*, and v1 counts *packets*: `get` there sends one
   * packet per OID, so a seven-OID read multiplied into thirty-five seconds. Measured
   * at 12.4 s over the whole probe path before this budget existed. The client now
   * carries an explicit ceiling; OIDs it did not get to are `null`, which is a partial
   * reading rather than a call that never returns.
   */
  /** La sonde en cours, s'il y en a une. Voir {@link probeAddress}. */
  private probeQueue: Promise<void> = Promise.resolve();

  async probeAddress(host: string, community = 'public', port = 161): Promise<AddressProbe> {
    // 🔴 Sérialisé, comme `startScan` l'est déjà. Sans plafond, chaque appel ouvre une
    // négociation de version, jusqu'à trois sondes de dialecte, une lecture d'identité
    // et — quand SNMP a renoncé — quatre connexions TCP. Une vue qui réémettrait
    // `/probe` en rafale, ou un onglet dupliqué, empilerait tout cela sans limite sur
    // un Homey dont le nombre de descripteurs est compté — c'est d'ailleurs la raison
    // d'être du plafond de concurrence du balayage.
    //
    // Les sondes s'enchaînent donc plutôt que de s'empiler. Une sonde dure quelques
    // secondes ; attendre son tour est préférable à épuiser les sockets de l'app.
    const mine = this.probeQueue.then(() => this.probeOne(host, community, port));
    // La file ne doit pas mourir sur un échec : on la relance quoi qu'il arrive.
    this.probeQueue = mine.then(() => undefined, () => undefined);
    return mine;
  }

  /** La sonde elle-même, sérialisée par {@link probeAddress}. */
  private async probeOne(host: string, community: string, port: number): Promise<AddressProbe> {
    const empty: AddressProbe = {
      host,
      outcome: 'silent',
      version: null,
      source: null,
      description: null,
      name: null,
      identity: null,
    };

    const version = await negotiateVersion(host, community, PROBE_NEGOTIATE_MS, port);
    if (version === null) {
      const reachable = await isReachable(host);
      trace.info('probe', `${host} is silent over SNMP`, { joignable: reachable });
      return { ...empty, outcome: reachable ? 'reachable' : 'silent' };
    }

    const client = new SnmpClient({
      host,
      community,
      version,
      port,
      timeout: PROBE_READ_MS,
      retries: 0,
      // Ce qui reste des dix secondes une fois la négociation payée. Décisif en v1,
      // sans effet en v2c où un `get` tient dans un paquet.
      budgetMs: PROBE_BUDGET_MS,
    });

    let description: string | null = null;
    let name: string | null = null;
    try {
      const system = await client.get([SYS_DESCR, SYS_NAME]);
      description = asText(system.get(SYS_DESCR));
      name = asText(system.get(SYS_NAME));
    } catch {
      // It answered during negotiation, so it is there; the description is a
      // nicety and its absence must not turn a live device into a silent one.
    }

    const answered: AddressProbe = { ...empty, outcome: 'snmp', version, description, name };

    let detection;
    try {
      detection = await detectUpsSource(client);
    } catch (error) {
      trace.warn('probe', `${host} stopped answering during detection`, error);
      return answered;
    }

    if (detection.reader === null) {
      trace.info('probe', `${host} answers SNMP but is not a UPS`, {
        déclinés: detection.declined,
      });
      return answered;
    }

    let identity: UpsIdentity = { model: null, manufacturer: null, serial: null };
    try {
      identity = await detection.reader.readIdentity(client);
    } catch (error) {
      trace.warn('probe', `identity unreadable at ${host}`, error);
    }

    trace.info('probe', `${host} is a UPS`, {
      source: detection.reader.source,
      modèle: identity.model,
    });

    return { ...answered, outcome: 'ups', source: detection.reader.source, identity };
  }
}

/** An SNMP value as a trimmed, bounded string — or `null` when there was none. */
function asText(value: string | number | Buffer | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = (Buffer.isBuffer(value) ? value.toString('utf8') : String(value)).trim();
  if (text === '') return null;
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}…` : text;
}

/**
 * Whether anything at all is at that address, without ICMP.
 *
 * Homey apps cannot open a raw socket, so there is no ping. A TCP connection
 * attempt answers the same question well enough: a host that *refuses* the
 * connection proved it exists just as surely as one that accepts it. Only a
 * timeout is inconclusive, and a few common ports are tried at once so that one
 * closed port does not decide the answer.
 *
 * Never throws: this runs to improve a message, and must not be able to fail the
 * probe that calls it.
 */
async function isReachable(host: string): Promise<boolean> {
  const attempts = REACHABILITY_PORTS.map(
    (port) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (value: boolean): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(value);
        };

        const socket = net.createConnection({ host, port });
        socket.setTimeout(REACHABILITY_TIMEOUT_MS);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', (error: NodeJS.ErrnoException) => {
          // A refusal is proof of life; "no route to host" is proof of the opposite.
          done(error.code === 'ECONNREFUSED');
        });
      }),
  );

  try {
    const results = await Promise.all(attempts);
    return results.some(Boolean);
  } catch {
    return false;
  }
}
