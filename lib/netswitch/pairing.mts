/**
 * Ce qu'un port proposé au pairing est, et comment on le nomme.
 *
 * Vit dans `lib/` et non dans `drivers/` pour une raison de fond : **rien de ce qui vit
 * dans un driver n'est atteignable par un test**, le paquet `homey` étant la CLI et non
 * le SDK runtime. Or les règles rassemblées ici sont exactement celles dont une erreur ne
 * produit aucun message :
 *
 * - 🔴 une clé en trop dans un résultat de pairing **vide la liste silencieusement**, et
 *   le SDK type ça `any[]` (rétro §8.1, panne 6) ;
 * - 🔴 un identifiant bâti sur l'`ifIndex` condamne l'appareil au prochain redémarrage du
 *   switch, qui renumérote ses interfaces — `data` est figé à la création et ne se
 *   rattrape jamais.
 *
 * Le pairing d'un switch a en plus une contrainte que l'onduleur n'avait pas : **il crée
 * plusieurs appareils**. C'est permis — plusieurs résultats du même driver, chacun avec
 * son propre `data.id`, l'hôte partagé dans `settings` — mais ça multiplie par N toute
 * erreur d'identifiant. D'où {@link assertDistinctIds}, qui est un test déguisé en
 * fonction : deux ports qui reçoivent le même identifiant produiraient un seul appareil
 * Homey, et l'utilisateur en verrait vingt-trois là où il en a coché vingt-quatre.
 */

import type { SnmpVersion } from '../snmp/client.mjs';
import type { CapabilityValue } from '../ups/capability-map.mjs';
import type { PoePortRef } from './poe-mib.mjs';
import { portLabel, type PortIdentity } from './port.mjs';

/**
 * 🔴 Les seules clés qu'un résultat de pairing a le droit de porter.
 *
 * Toute autre clé — `class`, `host`, `zone` — vide la liste sans un mot : pas d'erreur,
 * pas de log. Cette liste sert de garde de test ; le type {@link PortPairingDevice} sert
 * de garde de compilation. Il faut les deux, parce qu'un objet assemblé dynamiquement
 * échappe au second.
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

/** Ce que le device retrouvera dans son `store`, et qui ne bouge pas. */
export interface PortStore {
  /** L'identité du switch, partagée par tous ses ports. Sert à les regrouper. */
  switchKey: string;
  /** L'index au moment du pairing. **Un raccourci, pas une identité** — voir `port.mts`. */
  ifIndex: number;
  /** `ifName`, la clé de réalignement de l'index après un redémarrage du switch. */
  ifName: string | null;
  /** `ifDescr`, le repli quand l'agent n'a pas d'`ifXTable`. */
  ifDescr: string | null;
  /** La prise PoE, quand la correspondance tenait au pairing. `null` sinon. */
  poeGroup: number | null;
  poePort: number | null;
}

/**
 * Ce qu'on passe à `Homey.createDevice()`, et rien d'autre.
 *
 * TypeScript refuse une propriété excédentaire sur un littéral d'objet : tant que les
 * candidats sont construits par {@link buildPortCandidate}, la panne 6 est une erreur de
 * compilation plutôt qu'une liste vide sur du vrai matériel.
 */
export interface PortPairingDevice {
  name: string;
  data: { id: string };
  store: PortStore;
  settings: { host: string; community: string; port: number; version: SnmpVersion };
  /**
   * Les capabilities décidées sur ce que le port a **réellement** su répondre.
   *
   * Les passer à la création plutôt que de les ajouter au premier relevé évite la fenêtre
   * pendant laquelle l'appareil n'affiche qu'une ligne. `syncCapabilities` reste branché
   * dans la boucle de relevé, et reste idempotent : il ne réécrit rien quand le plan est
   * déjà satisfait.
   *
   * 🔴 `onoff` n'y figure jamais : `allow_control` naît à `false`, donc l'appareil naît
   * sans commande.
   */
  capabilities: string[];
}

/** Un port tel que la vue de pairing le montre. */
export interface PortCandidate {
  /** Identifiant de ligne dans la vue. C'est aussi `device.data.id`. */
  id: string;
  /** « Gi1/0/5 — Caméra jardin ». */
  label: string;
  /** « lien actif · 1000 Mbit/s · PoE » — ce qui aide à reconnaître le bon port. */
  detail: string;
  /** Vrai quand le lien est actif : la vue coche ceux-là d'office. */
  linkUp: boolean;
  /** À passer **tel quel** à `Homey.createDevice()`. */
  device: PortPairingDevice;
}

/** Tout ce qu'il faut pour proposer un port. */
export interface PortCandidateInput {
  identity: PortIdentity;
  switchKey: string;
  switchName: string | null;
  host: string;
  community: string;
  /** Le port UDP de l\'agent, tel que la sonde l\'a effectivement interrogé. */
  port: number;
  version: SnmpVersion;
  poe: PoePortRef | null;
  capabilities: string[];
  /** Le premier relevé, pour la ligne de détail. */
  values: readonly CapabilityValue[];
  linkUp: boolean;
  speedMbps: number | null;
}

/**
 * L'identité durable d'un switch.
 *
 * Le numéro de série d'abord — `entPhysicalSerialNum` de l'ENTITY-MIB, que la plupart des
 * switchs administrables publient. À défaut le nom que l'agent se donne. À défaut
 * l'adresse, parce qu'alors c'est littéralement la seule chose qui le distingue.
 */
export function switchKeyOf(serial: string | null, sysName: string | null, host: string): string {
  const bySerial = slug(serial);
  if (bySerial !== '') return `serial:${bySerial}`;
  const byName = slug(sysName);
  if (byName !== '') return `name:${byName}`;
  return `host:${host}`;
}

/**
 * L'identité durable d'un port.
 *
 * 🔴 **Jamais l'`ifIndex` seul.** Beaucoup d'agents renumérotent au redémarrage, et
 * certains décalent tout quand un module optionnel est retiré : un identifiant bâti sur
 * l'index désigne alors le port voisin, l'appareil continue de relever, et rien ne le
 * signale. `ifName` est stable — c'est le nom de la prise gravé dans la configuration du
 * switch. L'index ne sert de repli que sur un agent qui ne publie ni nom ni description,
 * et il est alors, là encore, la seule chose qui distingue le port.
 */
export function portDeviceId(switchKey: string, identity: PortIdentity): string {
  const byName = slug(identity.name);
  if (byName !== '') return `netswitch:${switchKey}:port:${byName}`;
  const byDescr = slug(identity.description);
  if (byDescr !== '') return `netswitch:${switchKey}:port:${byDescr}`;
  return `netswitch:${switchKey}:index:${identity.ifIndex}`;
}

/** Assemble un candidat. Seul endroit du dépôt où un résultat de pairing de port est fabriqué. */
export function buildPortCandidate(input: PortCandidateInput): PortCandidate {
  const id = portDeviceId(input.switchKey, input.identity);
  const label = portLabel(input.identity);
  const switchName = (input.switchName ?? '').trim();

  return {
    id,
    label,
    detail: describePort(input),
    linkUp: input.linkUp,
    device: {
      // Le nom du switch devant celui du port : dans une liste d'appareils Homey triée
      // alphabétiquement, les vingt-quatre ports d'un même switch se retrouvent ainsi
      // groupés — au lieu d'être éparpillés entre les autres appareils de la maison.
      name: switchName === '' ? label : `${switchName} · ${label}`,
      data: { id },
      store: {
        switchKey: input.switchKey,
        ifIndex: input.identity.ifIndex,
        ifName: input.identity.name,
        ifDescr: input.identity.description,
        poeGroup: input.poe?.group ?? null,
        poePort: input.poe?.port ?? null,
      },
      settings: { host: input.host, community: input.community, port: input.port, version: input.version },
      capabilities: [...input.capabilities],
    },
  };
}

/** « lien actif · 1000 Mbit/s · PoE alimenté ». Ce qui aide à reconnaître le bon port. */
function describePort(input: PortCandidateInput): string {
  const parts: string[] = [];
  parts.push(input.linkUp ? 'link up' : 'link down');
  if (input.speedMbps !== null && input.speedMbps > 0) parts.push(`${input.speedMbps} Mbit/s`);
  if (input.poe !== null) parts.push(`PoE ${input.poe.group}/${input.poe.port}`);
  const alias = (input.identity.alias ?? '').trim();
  if (alias !== '' && (input.identity.name ?? '').trim() === '') parts.push(alias);
  return parts.join(' · ');
}

/**
 * Vérifie qu'aucun identifiant n'est en double avant que la vue n'adopte quoi que ce soit.
 *
 * 🔴 Deux ports du même identifiant produiraient **un seul** appareil Homey — le second
 * `createDevice()` échoue, ou écrase le premier, selon la version du SDK. Dans les deux
 * cas l'utilisateur coche vingt-quatre ports et en obtient vingt-trois, sans un mot. Un
 * agent qui rend deux fois le même `ifName` suffit à provoquer ça, et ça se voit d'autant
 * moins que le pairing d'un switch est le seul du dépôt à créer plusieurs appareils.
 *
 * @returns les identifiants apparus plus d'une fois, vide quand tout va bien
 */
export function duplicateIds(candidates: readonly PortCandidate[]): string[] {
  const seen = new Set<string>();
  const doubled = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) doubled.add(candidate.id);
    seen.add(candidate.id);
  }
  return [...doubled];
}

/**
 * Désambiguïse les identifiants en double plutôt que de perdre des ports.
 *
 * L'`ifIndex` est un mauvais identifiant durable, mais c'est un excellent
 * **discriminant** : quand deux ports portent le même nom, il est la seule chose qui les
 * sépare. On ne l'utilise donc que là, sur les seuls ports concernés, et le reste de
 * l'inventaire garde son identifiant stable.
 */
export function disambiguate(candidates: readonly PortCandidate[]): PortCandidate[] {
  const doubled = new Set(duplicateIds(candidates));
  if (doubled.size === 0) return [...candidates];

  return candidates.map((candidate) => {
    if (!doubled.has(candidate.id)) return candidate;
    const id = `${candidate.id}#${candidate.device.store.ifIndex}`;
    return { ...candidate, id, device: { ...candidate.device, data: { id } } };
  });
}

/** Réduit une valeur d'agent à quelque chose d'utilisable dans un identifiant. */
export function slug(value: string | null): string {
  if (value === null) return '';
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
