/**
 * The app's own HTTP API, backing the settings page.
 *
 * Every endpoint here has to answer well inside ten seconds — that is where
 * Homey cuts an app API call off — so nothing long-running is ever awaited in
 * one. Reads are short and unretried, and anything that takes longer is started
 * and then polled.
 */

import type NetDevicesApp from './app.mjs';

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

/**
 * Homey resolves endpoints off the default export, keyed by the names declared
 * in `.homeycompose/app.json`.
 */
export default { getTrace };
