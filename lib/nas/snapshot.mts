/**
 * Le contrat de l'hôte, tel que tout ce qui est au-dessus du lecteur le voit.
 *
 * Contrairement à l'onduleur, il n'y a **qu'un seul dialecte** : HOST-RESOURCES-MIB est
 * standard, et un Synology, un QNAP, un Linux avec `snmpd` et un ESXi y répondent la
 * même chose. Ce fichier n'a donc pas de `NasSource` — il n'y a rien à choisir. Ce qu'il
 * garde du modèle onduleur, ce sont les deux règles qui portent tout le reste :
 *
 * 1. **`null` veut dire « on ne sait pas », et se propage jusqu'à la capability.** Jamais
 *    `0`. Un volume à 0 % est un volume vide ; un volume dont la taille n'a pas pu être
 *    lue est `null`. Une charge CPU à 0 % est une machine au repos ; une charge absente
 *    est `null`. Les confondre remplirait Insights de zéros qui ressemblent à des
 *    mesures et déclencherait — ou taira — les Flows sur du vide.
 * 2. **Les unités sont normalisées ici, pas plus haut.** Les pourcentages sont des
 *    pourcentages, l'uptime est en **jours**, la température en °C, les tailles en
 *    octets. `hrStorageSize` en unités d'allocation et `hrSystemUptime` en centièmes de
 *    seconde ne franchissent jamais cette frontière.
 */

/** Ce qu'un hôte dit de lui-même. Lu au pairing puis au rythme lent : ça ne bouge pas. */
export interface NasIdentity {
  /** `sysName` — le nom que la machine se donne, celui que l'utilisateur reconnaît. */
  name: string | null;
  /** `sysDescr`, tronqué — « Linux DiskStation 4.4.302+ … ». */
  description: string | null;
}

/**
 * Ce qui doit être relu régulièrement (~60 s).
 *
 * Le rythme est bien plus lent que celui de l'onduleur, et à dessein : une coupure de
 * courant se mesure en secondes, une charge CPU ne se pilote pas. Marteler `snmpd`
 * toutes les dix secondes pour lire une moyenne sur une minute n'apprendrait rien et
 * coûterait du CPU sur la machine même dont on mesure le CPU.
 */
export interface NasLive {
  /**
   * Uptime, **en jours**. `hrSystemUptime` déborde à ~497 jours (voir `host-mib.mts`) :
   * un hôte qui dépasse cette durée voit son uptime repartir de zéro, ce qui est
   * indiscernable d'un redémarrage. C'est dit dans le texte de la carte de Flow.
   */
  uptimeDays: number | null;
  /** Charge CPU **moyennée sur tous les cœurs**, en %. */
  cpuLoad: number | null;
  /**
   * Combien de cœurs ont répondu.
   *
   * Sert au journal et au libellé, **jamais** à la logique : `cpuLoad` est déjà la
   * moyenne, et un consommateur qui recalculerait à partir de ce compte se tromperait
   * dès qu'un cœur cesse de répondre. Vaut `0` quand la table n'a rien rendu, auquel cas
   * `cpuLoad` vaut `null`.
   */
  cpuCount: number;
  /**
   * Mémoire physique occupée, en %.
   *
   * ⚠️ Sous Linux, la ligne « Physical memory » de `hrStorageTable` compte le cache et
   * les tampons comme occupés : un NAS en bonne santé y affiche couramment 80 à 95 %,
   * parce que de la RAM inutilisée est de la RAM gaspillée. C'est la valeur que l'agent
   * publie, et on ne la corrige pas — on l'explique dans le réglage.
   */
  memoryUsedPercent: number | null;
}

/** Pourquoi une ligne de `hrStorageTable` n'est pas devenue un volume. Diagnostic pur. */
export type VolumeRejection =
  /** `hrStorageType` désigne autre chose qu'un système de fichiers (RAM, swap, cache…). */
  | 'not-a-filesystem'
  /** Type absent ou hors de la MIB : on ne sait pas ce que c'est, donc on n'affiche pas. */
  | 'unknown-type'
  /** Point de montage virtuel : `/dev/shm`, `/run`, `/proc`… */
  | 'pseudo-mount'
  /** Taille nulle, négative, ou occupation incohérente. */
  | 'no-usable-size'
  /**
   * Au-delà du plafond de volumes retenus.
   *
   * 🔴 Chaque volume devient une sous-capability, avec son journal Insights, et une
   * capability n'est **jamais** retirée — `removeCapability` détruirait cet historique.
   * Un hôte qui publierait des centaines de lignes de `hrStorageTable` ferait donc
   * gonfler l'appareil de façon irréversible, sans autre issue que de le supprimer et le
   * réappairer. Le plafond n'est pas une limite de travail, c'est un cliquet.
   */
  | 'over-limit';

/** Un volume, tel qu'il finit en sous-capability. */
export interface NasVolume {
  /**
   * L'identifiant de sous-capability, dérivé du **point de montage**.
   *
   * 🔴 Jamais de `hrStorageIndex` : sur Linux il suit l'ordre de montage et change d'un
   * redémarrage à l'autre. Une sous-capability qui change de nom, c'est une courbe
   * Insights orpheline plus une nouvelle courbe vide — et `removeCapability` étant hors
   * de question, la première reste affichée pour toujours.
   */
  key: string;
  /** `hrStorageDescr` tel quel : « /volume1 », « C:\ », « / ». C'est le titre affiché. */
  label: string;
  usedPercent: number | null;
  sizeBytes: number | null;
  usedBytes: number | null;
}

/** Ce qui peut attendre le rythme lent (~15 min) : la carte des volumes, la température. */
export interface NasDetail {
  /** Les volumes retenus, dans l'ordre où l'agent les publie. */
  volumes: NasVolume[];
  /** Les lignes écartées, avec la raison. Diagnostic uniquement, jamais de la logique. */
  rejected: { label: string; reason: VolumeRejection }[];
  /** La plus élevée des températures publiées par l'hôte, en °C. */
  temperature: number | null;
  /**
   * L'index de la ligne « mémoire physique » dans `hrStorageTable`.
   *
   * Retenu parce que le relevé rapide relit **cette ligne-là** par un `get` ciblé plutôt
   * que de reparcourir toute la table toutes les minutes : un hôte avec vingt points de
   * montage, ce sont cent vingt varbinds par relevé pour trois valeurs utiles.
   *
   * `null` tant que le premier relevé lent n'a pas eu lieu — auquel cas la mémoire est
   * simplement inconnue, et non zéro.
   */
  memoryIndex: number | null;
}

/** Tout ce qu'un cycle complet apprend. */
export interface NasSnapshot extends NasIdentity, NasLive, NasDetail {}

/** Le strict nécessaire qu'un lecteur demande au transport. */
export type SnmpValue = string | number | Buffer | null;

/**
 * Ce que le lecteur attend du client SNMP.
 *
 * Il exige `walk` en plus de `get`, contrairement au contrat onduleur
 * (`lib/ups/snapshot.mts`) qui n'a besoin que de `get` : ici le **nombre de lignes est
 * précisément ce qu'on ne doit pas présumer**. Un NAS a un cœur ou seize, un volume ou
 * douze, et coder en dur les index `1..N` rendrait un hôte à index épars — le cas normal
 * sous Linux — partiellement muet, sans une erreur.
 */
export interface NasSnmpSource {
  get(oids: string[]): Promise<Map<string, SnmpValue>>;
  walk(rootOid: string, maxRepetitions?: number): Promise<Map<string, SnmpValue>>;
}

/**
 * Ce qu'on publie quand on a atteint le seuil d'échecs.
 *
 * 🔴 Toutes les mesures repartent à `null` — « on ne sait plus » — et surtout pas à `0`,
 * qui afficherait un NAS au repos avec des disques vides au moment précis où il ne
 * répond plus. `cpuCount` vaut `0` parce que c'est un compte, pas une mesure : zéro cœur
 * a répondu, ce qui est exactement vrai.
 *
 * Contrairement à l'onduleur, il n'y a **pas de gel** ici : le §3.8 du plan protège une
 * information qu'on perd au moment où elle compte — l'état d'une coupure de courant en
 * cours. Un NAS injoignable n'a pas d'équivalent : sa charge CPU d'il y a dix minutes ne
 * dit rien de maintenant, et la figer serait un mensonge sans contrepartie.
 */
export const NAS_LIVE_UNKNOWN: NasLive = {
  uptimeDays: null,
  cpuLoad: null,
  cpuCount: 0,
  memoryUsedPercent: null,
};

/** Un détail qu'aucun relevé n'a encore rempli. Explicite, pour ne pas le confondre avec vide. */
export const NAS_UNKNOWN_DETAIL: NasDetail = {
  volumes: [],
  rejected: [],
  temperature: null,
  memoryIndex: null,
};
