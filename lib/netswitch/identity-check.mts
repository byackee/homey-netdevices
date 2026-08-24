/**
 * Vise-t-on encore le port qu'on croit viser ?
 *
 * 🔴 Une écriture SNMP part sur un **index**, jamais sur un nom. Or l'index d'un port
 * n'est pas stable : un switch qui redémarre peut renuméroter ses interfaces, et le
 * dépôt le documente déjà pour la lecture. Pour l'écriture, la conséquence change de
 * nature — on ne fausse pas une courbe, **on coupe le mauvais port**.
 *
 * Le réalignement d'index n'a lieu qu'au relevé lent : 300 secondes par défaut, et
 * jusqu'à vingt-quatre heures selon le réglage. Pendant tout cet intervalle, une carte de
 * Flow « éteindre ce port » écrirait sur l'ancien numéro. Le relevé rapide ne rattrape
 * rien : il lit sans broncher le nouveau port sous l'ancien index, et l'appareil reste
 * annoncé disponible.
 *
 * Le refus `no-port` existait déjà, mais il n'arrivait qu'**après** le réalignement —
 * c'est-à-dire trop tard, précisément quand il aurait servi. D'où ce contrôle, juste
 * avant d'émettre : un aller-retour de plus sur une action déclenchée à la main ne coûte
 * rien, et c'est la seule chose qui distingue « je vise le port qu'on m'a désigné » de
 * « je vise l'index que j'avais noté ».
 *
 * Ni le transport ni l'agent ne peuvent aider ici : une écriture bien formée sur un OID
 * valide qui vise le mauvais port **réussit**, et remonte comme un succès.
 */

/** Ce que l'appairage avait retenu de ce port. */
export interface StoredPortIdentity {
  ifName: string | null;
  ifDescr: string | null;
}

/** Ce que l'agent en dit maintenant. */
export type LivePortIdentity = StoredPortIdentity;

export type IdentityVerdict =
  /** Les deux concordent : l'index désigne toujours le même port. */
  | 'same'
  /** Ils divergent : l'index a été renuméroté, ou il désigne un autre appareil. */
  | 'changed'
  /**
   * Rien à comparer.
   *
   * Soit l'appairage n'avait rien retenu — appareil créé par une version antérieure —
   * soit l'agent ne rend ni nom ni description. Dans les deux cas l'écriture passe :
   * inventer un refus qu'on ne sait pas justifier priverait de la commande des appareils
   * qui n'ont rien fait de mal. C'est le même arbitrage que pour les volumes, où le doute
   * profite à la fonction tant que rien ne prouve l'erreur.
   */
  | 'unknown';

/** Normalise pour la comparaison : un agent peut changer l'espacement sans changer de port. */
function normalise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Compare ce qui a été retenu à ce que l'agent dit maintenant.
 *
 * `ifName` prime sur `ifDescr` : c'est le nom court et stable de l'`ifXTable`
 * (« Gi0/5 »), là où `ifDescr` porte parfois une description que le firmware réécrit
 * d'une version à l'autre. Mais `ifName` vient d'une table optionnelle — quand il manque
 * des deux côtés, `ifDescr` fait foi, et il est obligatoire dans l'`ifTable`.
 */
export function comparePortIdentity(
  stored: StoredPortIdentity,
  live: LivePortIdentity,
): IdentityVerdict {
  for (const champ of ['ifName', 'ifDescr'] as const) {
    const avant = normalise(stored[champ]);
    const apres = normalise(live[champ]);
    if (avant === null || apres === null) continue;
    return avant === apres ? 'same' : 'changed';
  }
  return 'unknown';
}
