/**
 * Ce qu'un candidat de pairing NAS est, et comment on le nomme.
 *
 * Séparé de `driver.mts` pour la même raison que `lib/nas/poll-engine.mts` l'est de
 * `device.mts` : `Homey.Driver` ne s'instancie pas hors du runtime Homey, donc **rien de
 * ce qui vit dans le driver n'est atteignable par un test**. Or les règles rassemblées
 * ici sont exactement celles dont une erreur ne produit aucun message :
 *
 * - une clé en trop dans un résultat de pairing **vide la liste silencieusement**, et le
 *   SDK type ça `any[]` (rétro §8.1, panne 6) ;
 * - un identifiant d'appareil bâti sur l'adresse IP condamne l'appareil au prochain bail
 *   DHCP — `data` est figé à la création et ne se rattrape jamais (plan §3.5) ;
 * - deux hôtes qui portent le même nom donnent le même identifiant, et le second
 *   **disparaît de la liste** au lieu de lever une erreur.
 *
 * Aucune des trois ne se voit à l'exécution, aucune ne se voit à la validation. Ici,
 * elles se testent.
 */

import type { SnmpVersion } from '../../lib/snmp/client.mjs';
import type { CapabilityOptions } from '../../lib/nas/capability-map.mjs';

/**
 * 🔴 Les seules clés qu'un résultat de pairing a le droit de porter.
 *
 * Toute autre clé — `class`, par exemple, qui semble si naturelle — vide la liste sans un
 * mot : pas d'erreur, pas de log. Cette liste sert de garde de test ; le type
 * {@link NasPairingDevice} sert de garde de compilation. Il faut les deux, parce qu'un
 * objet assemblé dynamiquement échappe au second.
 *
 * Recopiée de `drivers/ups/pairing.mts` volontairement plutôt qu'importée : c'est la
 * liste que le SDK admet, pas une liste que ce dépôt décide, et deux drivers qui la
 * partageraient par import donneraient l'impression qu'on peut la changer.
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
 * candidats sont construits par {@link buildNasCandidate}, la panne 6 est une erreur de
 * compilation plutôt qu'une liste vide sur du vrai matériel.
 *
 * 🔴 `capabilities` et `capabilitiesOptions` sont posées **dès le pairing**, contrairement
 * au driver onduleur qui les laisse au premier relevé. C'est le correctif n°1 de la revue
 * SDK, appliqué d'emblée : un appareil créé avec sa liste complète affiche ses mesures à
 * la seconde où il apparaît, au lieu de n'avoir qu'une tuile vide jusqu'au premier cycle
 * lent. Le device réaligne ensuite — c'est le seul chemin de rattrapage quand un volume
 * apparaît des mois plus tard.
 */
export interface NasPairingDevice {
  name: string;
  data: { id: string };
  store: { mac: string | null };
  settings: { host: string; community: string; version: SnmpVersion };
  capabilities: string[];
  capabilitiesOptions: Record<string, CapabilityOptions>;
}

/** Un candidat tel que la vue le montre. */
export interface NasPairingCandidate {
  host: string;
  title: string;
  subtitle: string;
  vendor: string | null;
  /** À passer **tel quel** à `Homey.createDevice()`. */
  device: NasPairingDevice;
}

/** Tout ce qu'il faut savoir pour proposer une adresse. */
export interface NasCandidateInput {
  host: string;
  version: SnmpVersion;
  community: string;
  mac: string | null;
  vendor: string | null;
  /** `sysName`. */
  name: string | null;
  /** `sysDescr`, tronqué. */
  description: string | null;
  /** Les capabilities que l'hôte a réellement su alimenter, dans l'ordre d'affichage. */
  capabilities: string[];
  /** Les titres des sous-capabilities de volume. */
  options: Map<string, CapabilityOptions>;
  /** Combien de volumes ont été retenus — sert au sous-titre, pas à la logique. */
  volumeCount: number;
  /** Les identifiants déjà attribués, pour ne pas en fabriquer un doublon. */
  takenIds: ReadonlySet<string>;
}

/** Assemble un candidat. Seul endroit du dépôt où un résultat de pairing NAS est fabriqué. */
export function buildNasCandidate(input: NasCandidateInput): NasPairingCandidate {
  const title = suggestNasName(input.name, input.vendor, input.description, input.host);
  const details = [
    input.host,
    input.volumeCount === 1 ? '1 volume' : `${input.volumeCount} volumes`,
    `${input.capabilities.length} mesure(s)`,
  ];

  return {
    host: input.host,
    title,
    subtitle: details.join(' · '),
    vendor: input.vendor,
    device: {
      name: title,
      data: { id: nasDeviceId(input.mac, input.name, input.host, input.takenIds) },
      store: { mac: input.mac },
      settings: { host: input.host, community: input.community, version: input.version },
      capabilities: [...input.capabilities],
      capabilitiesOptions: Object.fromEntries(input.options),
    },
  };
}

/** Ce qu'on a décidé de faire d'une adresse qui parle bien HOST-RESOURCES-MIB. */
export interface HostOffer {
  /** `host` : offert à l'adoption. `nothing-readable` : la MIB répond, mais à vide. */
  reason: 'host' | 'nothing-readable';
  /** Le candidat, ou `null` quand il n'y a rien à offrir. */
  candidate: NasPairingCandidate | null;
}

/**
 * Décide si une adresse mérite d'être offerte, et assemble le candidat le cas échéant.
 *
 * 🔴 **Un hôte dont aucune mesure n'est lisible n'est pas offert.** Le créer donnerait un
 * appareil sans une seule capability : Homey afficherait une tuile vide, pour toujours,
 * et l'utilisateur n'aurait aucun moyen de comprendre pourquoi. Ce n'est pas une erreur —
 * un ESXi minimal, un agent bridé et un conteneur y ressemblent tous — donc ça ne lève
 * pas ; c'est un verdict distinct, que la vue traduit par la marche à suivre plutôt que
 * par « rien trouvé ».
 *
 * Cette règle vit ici, et non dans `driver.mts`, pour la raison habituelle : ce qui
 * vit dans `Homey.Driver` n'est atteignable par aucun test, et une règle qui décide de
 * ne rien montrer est exactement le genre de règle dont on ne remarque jamais qu'elle
 * s'est mise à tout écarter.
 */
export function offerHost(input: NasCandidateInput): HostOffer {
  if (input.capabilities.length === 0) return { reason: 'nothing-readable', candidate: null };
  return { reason: 'host', candidate: buildNasCandidate(input) };
}

/**
 * L'identité durable d'un hôte.
 *
 * 🔴 **Jamais l'adresse, tant qu'il y a mieux.** `data` est figé à la création et ne peut
 * plus changer : un identifiant bâti sur l'IP condamne l'appareil le jour où le bail DHCP
 * tourne, et la seule issue est de le supprimer et de le réappairer, en perdant son
 * historique Insights.
 *
 * L'ordre, et pourquoi il diffère de celui de l'onduleur :
 *
 * 1. **La MAC**, quand la découverte l'a vue. Côté onduleur elle ne vaut rien — un
 *    onduleur relayé par un NAS porte la MAC du *NAS*, donc celle d'un autre appareil.
 *    Ici, l'appareil interrogé **est** celui qui porte la MAC : c'est le seul identifiant
 *    vraiment matériel dont on dispose, HOST-RESOURCES-MIB ne publiant aucun numéro de
 *    série.
 * 2. **`sysName`**, à défaut. Il survit au DHCP, et l'utilisateur l'a souvent choisi
 *    lui-même. Il n'est pas matériel — quelqu'un peut renommer sa machine — mais entre
 *    « change si on la renomme » et « change au prochain bail », le premier est de très
 *    loin le plus rare.
 * 3. **L'adresse**, seulement quand l'hôte ne publie rien qui le distingue, parce
 *    qu'alors c'est littéralement la seule chose qui le distingue.
 *
 * 🔴 Et un garde-fou que le driver onduleur n'a pas : si l'identifiant calculé est
 * **déjà pris**, on retombe sur l'adresse. Deux Synology sortis du carton s'appellent
 * tous les deux `DiskStation` — sans ce repli, le second candidat porterait l'identifiant
 * du premier et la vue de pairing le **filtrerait comme déjà appairé**. Il disparaîtrait
 * de la liste sans un message, ce qui est très exactement la forme de panne que tout ce
 * fichier existe pour empêcher.
 */
export function nasDeviceId(
  mac: string | null,
  sysName: string | null,
  host: string,
  takenIds: ReadonlySet<string> = new Set(),
): string {
  // `slug()` rend la MAC insensible à sa casse et à son séparateur : `00:11:32:AA:BB:CC`
  // et `00-11-32-aa-bb-cc` désignent le même appareil et doivent donner le même id.
  const macKey = slug(mac);
  // Une MAC déjà prise désigne le **même** appareil, pas un homonyme : pas de repli ici,
  // le filtre « déjà appairé » de la vue a raison de l'écarter.
  if (macKey !== '') return `nas:mac:${macKey}`;

  const nameKey = slug(sysName);
  if (nameKey !== '' && !takenIds.has(`nas:name:${nameKey}`)) return `nas:name:${nameKey}`;

  return `nas:host:${host}`;
}

/** Réduit une valeur d'agent à quelque chose d'utilisable dans un identifiant. */
export function slug(value: string | null): string {
  if (value === null) return '';
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Le nom proposé à l'utilisateur.
 *
 * `sysName` d'abord, et c'est l'inverse de l'ordre retenu côté onduleur — à raison : une
 * carte réseau d'onduleur publie un modèle utile (« Smart-UPS 1500 ») et un `sysName`
 * générique, alors qu'un hôte publie un `sysDescr` illisible (« Linux DiskStation
 * 4.4.302+ #69057 SMP … x86_64 ») et un `sysName` que son propriétaire a choisi.
 *
 * La marque déduite de l'OUI complète le nom quand elle n'y est pas déjà : « Synology
 * DiskStation » plutôt que « DiskStation », mais jamais « Synology Synology-NAS ».
 */
export function suggestNasName(
  sysName: string | null,
  vendor: string | null,
  description: string | null,
  host: string,
): string {
  const named = (sysName ?? '').trim();
  const brand = (vendor ?? '').trim();

  if (named !== '') {
    if (brand === '' || named.toLowerCase().includes(brand.toLowerCase())) return named;
    return `${brand} ${named}`;
  }

  if (brand !== '') return `${brand} (${host})`;

  // `sysDescr` est un paragraphe, pas un nom : on n'en garde que le premier mot, qui est
  // en pratique le système (« Linux », « Windows », « VMware »). Mieux qu'une adresse
  // toute seule, et honnête sur ce qu'on sait.
  const first = (description ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? `Hôte (${host})` : `${first} (${host})`;
}

/**
 * Un seul candidat par adresse, le premier gagne.
 *
 * La découverte MAC et le balayage voient les mêmes appareils : les offrir deux fois
 * ferait créer deux appareils Homey pour un seul hôte, dont un condamné à ne rien lire.
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
