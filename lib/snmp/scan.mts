/**
 * Balayage d'un /24 : on pose à chaque adresse la question exacte que l'app posera
 * ensuite, et tout ce qui répond est par construction utilisable.
 *
 * mDNS a été écarté dans `homey-netprinter` et le reste ici : les appareils ne
 * s'accordent pas sur le service annoncé, une stratégie de découverte Homey lie un
 * driver à exactement un service, et un onduleur relayé par un NAS n'annonce
 * strictement rien qui parle d'onduleur.
 *
 * Recopié de `homey-netprinter/lib/network-scan.mts`, avec **la sonde en paramètre**
 * au lieu de la question « es-tu une imprimante ? » codée en dur. C'est la seule
 * différence de fond : la mécanique du sweep — pool de workers à curseur partagé,
 * concurrence plafonnée, remontée au fil de l'eau — est celle qui a été éprouvée.
 */

import { SnmpClient, type SnmpReader, type SnmpVersion } from './client.mjs';
import { trace } from './trace.mjs';

/**
 * Adresses sondées en même temps.
 *
 * Chaque sonde tient un socket UDP : c'est un vrai plafond de ressources, pas un
 * bouton de réglage. Un /24 ouvert d'un coup épuise les descripteurs sur Homey.
 */
const DEFAULT_CONCURRENCY = 24;

/** Une sonde, c'est un paquet sans réessai — un appareil plus lent que ça n'est pas au repos. */
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/**
 * Ce qu'une sonde reçoit : un client déjà pointé sur l'adresse à interroger.
 *
 * Le paramètre est typé `SnmpReader` et non `SnmpClient` pour que le balayage
 * reste testable sans réseau. En pratique on passe une lambda dont le paramètre
 * est inféré, donc ça ne change rien à l'appel.
 */
export type SnmpProbe<T> = (client: SnmpReader) => Promise<T | null>;

export interface ScanOptions<T> {
  /** Adresses déjà appairées, pour que la liste n'offre que du nouveau. */
  skip?: ReadonlySet<string>;
  /** Appelé dès qu'une adresse est identifiée, avant la fin du balayage. */
  onFound?: (found: T, host: string) => void;
  community?: string;
  version?: SnmpVersion;
  /** Délai par sonde, en millisecondes. */
  timeout?: number;
  concurrency?: number;
  /**
   * Fabrique de client, injectable.
   *
   * Sert au test — un balayage qui exige un vrai sous-réseau ne se teste pas, donc
   * ne se teste jamais, donc ne prouve rien.
   */
  createClient?: (host: string) => SnmpReader;
}

/**
 * Déduit le /24 à balayer d'une adresse de la forme « 192.168.50.251 » ou
 * « 192.168.50.251:80 », qui est ce que rend `homey.cloud.getLocalAddress()`.
 *
 * Rend null pour tout ce qui n'est pas de l'IPv4, plutôt que de deviner.
 */
export function subnetOf(localAddress: string): string | null {
  const host = localAddress.split(':')[0]?.trim() ?? '';
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  if (parts.some((p) => p === '' || !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.slice(0, 3).join('.');
}

/**
 * Balaye un /24 et rend ce que la sonde y a reconnu.
 *
 * Un balayage complet prend de l'ordre de quinze secondes, soit plus que les 10 s
 * auxquelles un appel d'API d'app est coupé (plan §8.2) : `onFound` remonte donc
 * chaque trouvaille au moment où elle répond, pour que l'appelant serve un
 * avancement au lieu de tenir une requête ouverte sur tout le balayage.
 *
 * @param subnet  les trois premiers octets, p. ex. « 192.168.50 »
 * @param probe   la question posée à chaque adresse ; rend null quand ce n'est pas la bonne
 */
export async function scanSubnet<T>(
  subnet: string,
  probe: SnmpProbe<T>,
  options: ScanOptions<T> = {},
): Promise<T[]> {
  const {
    skip = new Set<string>(),
    onFound,
    community = 'public',
    version = 'v2c',
    timeout = DEFAULT_PROBE_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
    createClient = (host: string): SnmpReader =>
      new SnmpClient({ host, community, version, timeout, retries: 0 }),
  } = options;

  const targets: string[] = [];
  for (let last = 1; last <= 254; last += 1) {
    const host = `${subnet}.${last}`;
    if (!skip.has(host)) targets.push(host);
  }

  trace.info('scan', `sweeping ${subnet}.0/24`, { targets: targets.length, skipped: skip.size });

  // On retient l'adresse à côté du résultat : la sonde est générique, le balayage
  // ne peut donc rien présumer de la forme de T — pas même qu'il porte un host.
  const found: { host: string; value: T }[] = [];
  let next = 0;

  // Pool de workers à curseur partagé, pour que le balayage tienne une concurrence
  // constante au lieu de procéder par rafales qui s'essoufflent en fin de lot.
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const host = targets[index];
      if (host === undefined) return;

      let value: T | null;
      try {
        value = await probe(createClient(host));
      } catch {
        // Injoignable, muet sur 161, ou sonde qui a levé : rien de tout cela ne
        // mérite d'interrompre le balayage des 253 autres adresses.
        continue;
      }
      if (value === null) continue;

      found.push({ host, value });
      // Un auditeur qui lève ne doit pas faire tomber le balayage qu'il observe.
      try {
        onFound?.(value, host);
      } catch (error) {
        trace.warn('scan', `onFound threw for ${host}`, error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker));

  // Les workers terminent dans le désordre : on retrie par dernier octet pour que
  // deux balayages du même réseau rendent la même liste dans le même ordre.
  found.sort((a, b) => Number(a.host.split('.')[3] ?? 0) - Number(b.host.split('.')[3] ?? 0));

  trace.info('scan', `sweep of ${subnet}.0/24 finished`, { found: found.length });

  return found.map((f) => f.value);
}
