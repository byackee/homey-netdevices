/**
 * Ce qu'un candidat de pairing est, et comment on le nomme.
 *
 * Séparé de `driver.mts` pour la même raison que `poll-engine.mts` l'est de `device.mts` :
 * `Homey.Driver` ne s'instancie pas hors du runtime Homey, donc **rien de ce qui vit dans
 * le driver n'est atteignable par un test**. Or les règles rassemblées ici sont exactement
 * celles dont une erreur ne produit aucun message :
 *
 * - une clé en trop dans un résultat de pairing **vide la liste silencieusement**, et le
 *   SDK type ça `any[]` (rétro §8.1, panne 6) ;
 * - un identifiant d'appareil bâti sur l'adresse IP condamne l'appareil au prochain bail
 *   DHCP — `data` est figé à la création et ne se rattrape jamais (plan §3.5).
 *
 * Aucune des deux ne se voit à l'exécution, aucune ne se voit à la validation. Ici, elles
 * se testent.
 */

import type { SnmpVersion } from '../../lib/snmp/client.mjs';
import type { UpsSource } from '../../lib/ups/snapshot.mjs';

/**
 * 🔴 Les seules clés qu'un résultat de pairing a le droit de porter.
 *
 * Toute autre clé — `class`, par exemple, qui semble si naturelle — vide la liste sans un
 * mot : pas d'erreur, pas de log. Cette liste sert de garde de test ; le type
 * `PairingDevice` sert de garde de compilation. Il faut les deux, parce qu'un objet
 * assemblé dynamiquement échappe au second.
 */
export const PAIRING_RESULT_KEYS = [
  'name',
  'data',
  'store',
  'settings',
  'icon',
  'capabilities',
  'capabilitiesOptions',
] as const;

/**
 * Ce qu'on passe à `Homey.createDevice()`, et rien d'autre.
 *
 * TypeScript refuse une propriété excédentaire sur un littéral d'objet : tant que les
 * candidats sont construits par `buildCandidate()`, la panne 6 est une erreur de
 * compilation plutôt qu'une liste vide sur du vrai matériel.
 */
export interface PairingDevice {
  name: string;
  data: { id: string };
  store: { source: UpsSource; serial: string | null; mac: string | null };
  settings: { host: string; community: string; port: number; version: SnmpVersion };
}

/**
 * Un candidat tel que la vue le montre.
 *
 * `device` est la seule partie que la vue passe à `Homey.createDevice()` — verbatim. Tout
 * le reste est de l'affichage et ne doit jamais atteindre Homey.
 */
export interface PairingCandidate {
  host: string;
  title: string;
  subtitle: string;
  vendor: string | null;
  source: UpsSource;
  /** À passer **tel quel** à `Homey.createDevice()`. */
  device: PairingDevice;
}

/** Tout ce qu'il faut savoir pour proposer une adresse. */
export interface CandidateInput {
  host: string;
  source: UpsSource;
  version: SnmpVersion;
  community: string;
  /** Le port UDP de l'agent, tel que la sonde l'a effectivement interrogé. */
  port: number;
  mac: string | null;
  vendor: string | null;
  model: string | null;
  manufacturer: string | null;
  serial: string | null;
  sysName: string | null;
}

/** Assemble un candidat. Seul endroit du dépôt où un résultat de pairing est fabriqué. */
export function buildCandidate(input: CandidateInput): PairingCandidate {
  const vendor = input.vendor ?? input.manufacturer;
  const title = suggestName(input.model, vendor, input.sysName, input.host);
  const details = [
    input.host,
    input.serial === null || input.serial === '' ? null : `nº ${input.serial}`,
    sourceLabel(input.source),
  ].filter((part): part is string => part !== null);

  return {
    host: input.host,
    title,
    subtitle: details.join(' · '),
    vendor,
    source: input.source,
    device: {
      name: title,
      data: { id: deviceId(input.source, input.serial, input.model, input.sysName, input.host) },
      store: { source: input.source, serial: input.serial, mac: input.mac },
      settings: { host: input.host, community: input.community, port: input.port, version: input.version },
    },
  };
}

/**
 * L'identité durable d'un appareil.
 *
 * 🔴 **Jamais l'adresse**, tant qu'il y a mieux. `data` est figé à la création et ne peut
 * plus changer : un identifiant bâti sur l'IP condamne l'appareil le jour où le bail DHCP
 * tourne, et la seule issue est de le supprimer et de le réappairer — en perdant son
 * historique Insights. Le numéro de série d'abord ; à défaut le modèle et le nom publiés ;
 * l'adresse seulement quand l'appareil ne publie rien qui le distingue, parce qu'alors
 * c'est littéralement la seule chose qui le distingue.
 */
export function deviceId(
  source: UpsSource,
  serial: string | null,
  model: string | null,
  sysName: string | null,
  host: string,
): string {
  const serialKey = slug(serial);
  if (serialKey !== '') return `${source}:serial:${serialKey}`;

  const identityKey = [slug(model), slug(sysName)].filter((part) => part !== '').join('-');
  if (identityKey !== '') return `${source}:id:${identityKey}`;

  return `${source}:host:${host}`;
}

/** Réduit une valeur d'agent à quelque chose d'utilisable dans un identifiant. */
export function slug(value: string | null): string {
  if (value === null) return '';
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Le nom proposé à l'utilisateur.
 *
 * Un agent SNMP publie rarement les trois champs : une carte APC donne un modèle, un
 * Synology donne son nom d'hôte et « Ups » comme modèle. On prend ce qu'il y a, dans
 * l'ordre où c'est le plus parlant, et on finit sur l'adresse — un appareil mal nommé
 * reste très préférable à un appareil qu'on n'a pas proposé.
 */
export function suggestName(
  model: string | null,
  vendor: string | null,
  sysName: string | null,
  host: string,
): string {
  const parts = [vendor, model].map((part) => (part ?? '').trim()).filter((part) => part !== '');

  // « Smart-UPS 1500 » et non « APC APC Smart-UPS 1500 » : beaucoup de modèles portent
  // déjà la marque, et la répétition mange la largeur d'écran d'un téléphone.
  const label =
    parts.length === 2 && parts[1]!.toLowerCase().includes(parts[0]!.toLowerCase())
      ? parts[1]!
      : parts.join(' ');

  if (label !== '') return label;
  const named = (sysName ?? '').trim();
  if (named !== '') return named;
  return `UPS (${host})`;
}

/** D'où vient la lecture, dit à l'utilisateur : c'est ce qui explique ce qu'il verra ensuite. */
export function sourceLabel(source: UpsSource): string {
  switch (source) {
    case 'synology':
      return 'relayed by a Synology NAS';
    case 'rfc1628':
      return 'RFC 1628';
    case 'apc':
      return 'APC PowerNet';
    default:
      return source;
  }
}

/**
 * Un seul candidat par adresse, le premier gagne.
 *
 * La découverte MAC et le balayage voient les mêmes appareils : les offrir deux fois ferait
 * créer deux appareils Homey pour un seul onduleur, dont un condamné à ne rien lire.
 */
export function dedupeByHost<T extends { host: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.host)) continue;
    seen.add(item.host);
    out.push(item);
  }
  return out;
}

/** L'adresse saisie dans la vue, nettoyée. */
export function hostOf(data: unknown): string {
  const body = (data ?? {}) as { host?: unknown };
  return String(body.host ?? '').trim();
}

/** La communauté saisie ; « public » quand elle est vide, jamais une chaîne vide. */
export function communityOf(data: unknown): string {
  const body = (data ?? {}) as { community?: unknown };
  return String(body.community ?? 'public').trim() || 'public';
}

/**
 * Le port UDP demandé, 161 par défaut.
 *
 * Un agent peut écouter ailleurs : un `snmpd` lancé sans privilèges ne peut pas prendre
 * 161, pas plus qu'un conteneur sans capacité réseau ou un simulateur de mise au point.
 * Hors bornes ou illisible, on retombe sur 161 plutôt que d'échouer — c'est ce que
 * l'utilisateur voulait dans tous les cas sauf celui qu'il a explicitement demandé.
 */
export function portOf(data: unknown): number {
  const body = (data ?? {}) as { port?: unknown };
  const port = Number(body.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 161;
}
