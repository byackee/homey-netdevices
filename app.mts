import 'source-map-support/register.js';
import Homey from 'homey';

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

/**
 * The app owns nothing a device owns — each device polls itself. What it does
 * own is the trace buffer, because an app installed with `homey app install`
 * has no readable log anywhere: Developer Tools lists App Store submissions
 * only, and the CLI has no log command. On the three apps that came before
 * this one, that buffer is what located every single failure, so it is wired
 * from the first commit rather than after the first outage.
 */
export default class NetDevicesApp extends Homey.App {
  private traceSource: TraceSource | null = null;

  override async onInit(): Promise<void> {
    this.log('SNMP - Network Devices app initialised');
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
}
