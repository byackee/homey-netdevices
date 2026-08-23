/**
 * Les préfixes OUI des constructeurs d'onduleurs, et ce qu'on en fait.
 *
 * Un onduleur n'annonce rien : pas de mDNS, pas de SSDP, rien qui dise « je suis un
 * onduleur » (plan §3.5). La seule stratégie de découverte du SDK v3 qui s'applique est
 * `mac` : elle cible les **trois premiers octets de l'adresse MAC** — le préfixe attribué
 * au constructeur par l'IEEE — et résout l'adresse courante par ARP. C'est ce qui donne
 * `onDiscoveryAddressChanged`, donc la résilience DHCP, sans dépendre d'aucune annonce.
 *
 * Le prix de cette approche est cette liste : elle est **à maintenir**, et elle ne verra
 * jamais un onduleur relayé par un appareil dont le constructeur n'y est pas. C'est
 * pourquoi elle ne remplace pas le balayage de sous-réseau — elle l'accélère quand elle
 * reconnaît quelque chose, et le balayage rattrape tout le reste.
 *
 * 🔴 **Chaque entrée est vérifiée dans le registre IEEE**, pas recopiée d'un forum :
 * `https://standards-oui.ieee.org/oui/oui.csv`, relevé le 2026-08-23. Le champ
 * `registrant` porte le nom **tel qu'il est enregistré**, qui n'est presque jamais le nom
 * commercial : Vertiv est enregistré « Emerson Network Power », Riello « RPS S.p.A. ».
 * Garder les deux noms est ce qui rend la liste re-vérifiable dans deux ans.
 *
 * La stratégie `mac` veut ces octets en **décimal** (`[0, 192, 183]` pour `00:C0:B7`),
 * pas en hexadécimal — un préfixe recopié en hex y est silencieusement faux, jamais
 * rejeté. `macPrefixes()` produit la forme attendue, et un test la compare au JSON de
 * découverte pour que les deux ne puissent pas diverger.
 */

/** Un préfixe attribué, et à qui. */
export interface OuiEntry {
  /** Les trois premiers octets, en décimal — la forme qu'attend la stratégie `mac`. */
  readonly prefix: readonly [number, number, number];
  /** Le nom déposé à l'IEEE, pour pouvoir re-vérifier l'entrée. */
  readonly registrant: string;
  /** La marque telle que l'utilisateur la connaît. */
  readonly vendor: string;
}

/**
 * Les préfixes qu'on surveille.
 *
 * Deux familles s'y côtoient et c'est voulu :
 * - les **cartes réseau d'onduleur** (APC, Eaton, CyberPower, Socomec, Riello, Vertiv,
 *   Tripp Lite, Salicru), qui parlent la RFC 1628 ou une MIB privée ;
 * - les **NAS** (Synology, QNAP), qui ne sont pas des onduleurs mais **relaient** celui
 *   qui leur est branché en USB — c'est le chemin d'adoption principal de l'app.
 *
 * Un NAS reconnu ici n'est donc pas « un onduleur trouvé » : c'est une adresse qui vaut
 * la peine d'être sondée. La sonde SNMP tranche, jamais la MAC.
 */
export const UPS_OUI: readonly OuiEntry[] = [
  // APC — la carte AP96xx historique. De loin le préfixe le plus répandu du parc.
  { prefix: [0x00, 0xc0, 0xb7], registrant: 'AMERICAN POWER CONVERSION CORP', vendor: 'APC' },
  // APC après le rachat par Schneider : les cartes NMC3 récentes portent celui-ci.
  { prefix: [0x28, 0x29, 0x86], registrant: 'APC by Schneider Electric', vendor: 'APC / Schneider' },

  // Eaton — deux blocs généraux du groupe…
  { prefix: [0x00, 0x20, 0x85], registrant: 'Eaton Corporation', vendor: 'Eaton' },
  { prefix: [0x00, 0x18, 0x64], registrant: 'Eaton Corporation', vendor: 'Eaton' },
  // …et celui de la division datacenter (ex-Pulizzi), qui couvre les cartes réseau.
  { prefix: [0x00, 0x22, 0xd5], registrant: 'Eaton Corp. Electrical Group Data Center Solutions - Pulizzi', vendor: 'Eaton' },

  // Synology — relais NUT du NAS, pas un onduleur. 001132 est le bloc historique,
  // 9009D0 celui des modèles récents.
  { prefix: [0x00, 0x11, 0x32], registrant: 'Synology Incorporated', vendor: 'Synology' },
  { prefix: [0x90, 0x09, 0xd0], registrant: 'Synology Incorporated', vendor: 'Synology' },

  // QNAP — même rôle de relais. Le lecteur QNAP n'est pas écrit (annexe A §6b), donc
  // ces adresses ne donneront un onduleur que si le NAS répond en RFC 1628.
  { prefix: [0x24, 0x5e, 0xbe], registrant: 'QNAP Systems', vendor: 'QNAP' },
  { prefix: [0xe8, 0x43, 0xb6], registrant: 'QNAP Systems', vendor: 'QNAP' },

  { prefix: [0x00, 0x0c, 0x15], registrant: 'CyberPower Systems', vendor: 'CyberPower' },

  // Riello UPS est enregistré sous le nom de sa maison mère, RPS S.p.A. — aucune entrée
  // IEEE ne porte « Riello ».
  { prefix: [0x00, 0x02, 0x63], registrant: 'RPS S.p.A.', vendor: 'Riello' },

  { prefix: [0x00, 0x17, 0x4a], registrant: 'SOCOMEC', vendor: 'Socomec' },

  // Vertiv n'a aucune entrée à son nom : la société est l'ancienne division Emerson
  // Network Power, et ses onduleurs sont les Liebert. Les trois blocs comptent.
  { prefix: [0x00, 0x09, 0xf5], registrant: 'Emerson Network Power Co.', vendor: 'Vertiv / Liebert' },
  { prefix: [0x00, 0xe0, 0x86], registrant: 'Emerson Network Power', vendor: 'Vertiv / Liebert' },
  { prefix: [0x00, 0x08, 0x77], registrant: 'Liebert-Hiross Spa', vendor: 'Vertiv / Liebert' },

  { prefix: [0x00, 0x15, 0x9d], registrant: 'Tripp Lite', vendor: 'Tripp Lite' },
  { prefix: [0x00, 0x06, 0x67], registrant: 'Tripp Lite', vendor: 'Tripp Lite' },

  { prefix: [0x00, 0x19, 0xcf], registrant: 'SALICRU', vendor: 'Salicru' },
];

/**
 * Les préfixes sous la forme exacte que veut `.homeycompose/discovery/ups.json`.
 *
 * Copie profonde : le JSON de découverte est écrit à la main, ce tableau sert au test qui
 * vérifie qu'ils disent la même chose. Rendre les tableaux internes laisserait un appelant
 * modifier la liste de référence, et le test comparerait alors la liste à elle-même.
 */
export function macPrefixes(): number[][] {
  return UPS_OUI.map((entry) => [...entry.prefix]);
}

/**
 * Ramène une adresse MAC à ses douze caractères hexadécimaux minuscules.
 *
 * Homey rend la MAC d'un `DiscoveryResultMAC` sans garantie de forme, et l'ARP d'un
 * système à l'autre écrit `00:c0:b7:…`, `00-C0-B7-…` ou `00c0b7…`. Une comparaison de
 * chaînes brutes échouerait sur la casse ou sur le séparateur, **sans erreur** : elle
 * dirait simplement « constructeur inconnu ».
 *
 * Rend `null` sur tout ce qui n'est pas une MAC plausible, plutôt que de deviner. On
 * accepte aussi un préfixe de trois octets seul, parce que c'est tout ce dont
 * `vendorForMac` a besoin et qu'une table ARP tronquée existe.
 */
export function normaliseMac(mac: string): string | null {
  const hex = mac.trim().toLowerCase().replace(/[\s:.-]/g, '');
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length < 6 || hex.length % 2 !== 0 || hex.length > 16) return null;
  return hex;
}

/** Les trois premiers octets d'une MAC, en décimal, ou `null` si ce n'en est pas une. */
export function ouiOf(mac: string): [number, number, number] | null {
  const hex = normaliseMac(mac);
  if (hex === null) return null;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * La marque derrière une adresse MAC, ou `null` si le préfixe n'est pas dans la liste.
 *
 * Sert à nommer un candidat de pairing (« Onduleur APC (192.168.1.20) ») **avant** toute
 * lecture SNMP, donc à distinguer « l'appareil est là et il est d'une marque qu'on
 * connaît, mais il ne répond pas » de « il n'y a rien à cette adresse ». C'est
 * exactement la différence que le fil APC du forum ne fait pas depuis 2018.
 */
export function vendorForMac(mac: string): string | null {
  const oui = ouiOf(mac);
  if (oui === null) return null;
  const entry = UPS_OUI.find(
    (candidate) =>
      candidate.prefix[0] === oui[0] && candidate.prefix[1] === oui[1] && candidate.prefix[2] === oui[2],
  );
  return entry?.vendor ?? null;
}

/** Un préfixe sous la forme lisible `00:C0:B7`, pour les traces et les messages. */
export function formatOui(prefix: readonly [number, number, number]): string {
  return prefix.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
}
