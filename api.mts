/**
 * The app's own HTTP API, backing the settings page.
 *
 * Every endpoint here has to answer well inside ten seconds — that is where
 * Homey cuts an app API call off — so nothing long-running is ever awaited in
 * one. Reads are short and unretried, and anything that takes longer is started
 * and then polled: `POST /scan` kicks a sweep off and returns at once, `GET
 * /scan` reports how far it got. Awaiting the sweep instead is what made the
 * settings page of the previous app fail with a timeout, since a /24 takes
 * around sixteen seconds.
 */

import type NetDevicesApp from './app.mjs';
import type { ScanFinding, ScanState } from './app.mjs';

/** The shape Homey hands every endpoint. */
interface Request {
  homey: NetDevicesApp['homey'];
  body: Record<string, unknown>;
  query: Record<string, string>;
  params: Record<string, string>;
}

/** What the trace endpoint answers. */
interface TraceReply {
  /** False when no buffer is attached yet — an empty `lines` then means nothing is recording. */
  wired: boolean;
  lines: string[];
}

/**
 * The trace buffer's contents.
 *
 * Reading the buffer is a memory copy, so this is safely inside the API's ten
 * second budget however large the buffer grows.
 */
async function getTrace({ homey }: Request): Promise<TraceReply> {
  const app = homey.app as NetDevicesApp;
  return { wired: app.hasTraceSource(), lines: [...app.getTrace()] };
}

/** One address, as the settings page lists it. */
interface ScanEntry {
  host: string;
  /** The UPS dialect it speaks, or `null` for a device that merely answers SNMP. */
  source: string | null;
  description: string | null;
  name: string | null;
  model: string | null;
}

/** What both scan endpoints answer. */
interface ScanReply {
  running: boolean;
  subnet: string | null;
  error: string | null;
  /** Progress, so a sixteen-second sweep can show something moving. */
  done: number;
  total: number;
  /** Devices that answered a UPS dialect. */
  found: ScanEntry[];
  /** Devices that answered SNMP without being a UPS — a diagnosis, not noise. */
  others: ScanEntry[];
}

function entry(finding: ScanFinding): ScanEntry {
  return {
    host: finding.host,
    source: finding.source,
    description: finding.description,
    name: finding.name,
    model: finding.model,
  };
}

function scanReply(state: ScanState): ScanReply {
  return {
    running: state.running,
    subnet: state.subnet,
    error: state.error,
    // A finished sweep must never report a fraction: the page would show a bar
    // stuck at 96% next to a list that is already final.
    done: state.running ? Math.min(state.probed, state.total) : state.total,
    total: state.total,
    found: state.found.map(entry),
    others: state.others.map(entry),
  };
}

/**
 * Starts a subnet sweep and returns at once.
 *
 * The sweep belongs to the app, not to this endpoint: a second call while one is
 * running gets the sweep in flight, not a second sweep.
 */
async function postScan({ homey, body }: Request): Promise<ScanReply> {
  const app = homey.app as NetDevicesApp;
  const community = String(body.community ?? 'public').trim() || 'public';
  return scanReply(await app.startScan(new Set(), community));
}

/** Reports the running or last-finished sweep, partial results included. */
async function getScan({ homey }: Request): Promise<ScanReply> {
  const app = homey.app as NetDevicesApp;
  return scanReply(app.getScanState());
}

/** What testing one address answers. */
interface ProbeReply {
  host: string;
  /**
   * `ups` | `snmp` | `reachable` | `silent`.
   *
   * 🔴 `reachable` is the one that matters: the address is live but says nothing
   * over SNMP, which almost always means SNMP is switched off rather than that
   * anything is broken. Collapsing it into "not found" is precisely the mistake
   * that leaves users staring at "no devices found" with a perfectly good UPS on
   * the network.
   */
  outcome: string;
  version: string | null;
  source: string | null;
  description: string | null;
  name: string | null;
  model: string | null;
  manufacturer: string | null;
  serial: string | null;
}

/**
 * Tests one address and reports exactly what it answered — or exactly why it did not.
 *
 * Budgeted to stay inside the ten seconds: version negotiation, then at most
 * three dialect probes and one identity read, each on a short timeout with no
 * retry. The reachability check only runs when SNMP already gave up.
 */
async function postProbe({ homey, body }: Request): Promise<ProbeReply> {
  const app = homey.app as NetDevicesApp;
  const host = String(body.host ?? '').trim();
  const community = String(body.community ?? 'public').trim() || 'public';

  // An empty address is a user mistake, not a probe result: answering `silent`
  // would tell them the device is not there, which is not what happened.
  if (host === '') {
    return {
      host: '',
      outcome: 'no-host',
      version: null,
      source: null,
      description: null,
      name: null,
      model: null,
      manufacturer: null,
      serial: null,
    };
  }

  const probe = await app.probeAddress(host, community);
  return {
    host: probe.host,
    outcome: probe.outcome,
    version: probe.version,
    source: probe.source,
    description: probe.description,
    name: probe.name,
    model: probe.identity?.model ?? null,
    manufacturer: probe.identity?.manufacturer ?? null,
    serial: probe.identity?.serial ?? null,
  };
}

/**
 * Homey resolves endpoints off the default export, keyed by the names declared
 * in `.homeycompose/app.json`.
 */
export default { getTrace, getScan, postScan, postProbe };
