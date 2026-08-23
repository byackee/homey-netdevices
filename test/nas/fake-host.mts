/**
 * L'agent SNMP factice des tests d'hôte.
 *
 * Même parti pris que `test/ups/fake-source.mts`, avec une addition qui change tout :
 * il sait **parcourir**. Un hôte se lit par tables — volumes, cœurs, capteurs — et un
 * double qui ne saurait que `get` obligerait à coder les index en dur dans les tests,
 * c'est-à-dire à tester exactement l'hypothèse que le code a raison de ne pas faire.
 *
 * Trois comportements sont ceux d'un vrai agent, et chacun attrape un défaut réel :
 *
 * 1. **Un OID absent du dictionnaire est absent de la réponse** — et non présent à
 *    `null`. C'est ce que fait un agent qui ne connaît pas l'objet, et c'est ce qui
 *    force le lecteur à traiter « la clé n'est pas là » aussi bien que « la valeur est
 *    nulle ».
 * 2. **Le parcours rend le sous-arbre, pas la table entière.** Un `walk` mal préfixé
 *    ressort donc vide, au lieu de ramasser par hasard ce qu'il cherchait.
 * 3. **Les requêtes sont conservées.** « Quel OID a-t-on demandé » est la moitié des
 *    bugs de cette couche : un relevé rapide qui embarque un objet lent, un index de
 *    table à 0, un `get` sur une colonne au lieu d'une cellule.
 */

import type { NasSnmpSource, SnmpValue } from '../../lib/nas/snapshot.mjs';

export interface FakeHost extends NasSnmpSource {
  /** Les listes d'OID demandées par `get`, dans l'ordre. */
  readonly asked: string[][];
  /** Les racines parcourues par `walk`, dans l'ordre. */
  readonly walked: string[];
}

export interface FakeHostOptions {
  /** Les racines dont le parcours doit échouer — un groupe optionnel que l'agent refuse. */
  walkFails?: readonly string[];
  /** Vrai si `get` doit échouer : l'hôte est injoignable, pas incomplet. */
  getFails?: string;
}

export function fakeHost(
  values: Record<string, SnmpValue>,
  options: FakeHostOptions = {},
): FakeHost {
  const asked: string[][] = [];
  const walked: string[] = [];

  return {
    asked,
    walked,

    async get(oids: string[]): Promise<Map<string, SnmpValue>> {
      asked.push(oids);
      if (options.getFails !== undefined) throw new Error(options.getFails);
      const out = new Map<string, SnmpValue>();
      for (const oid of oids) {
        if (Object.prototype.hasOwnProperty.call(values, oid)) out.set(oid, values[oid]!);
      }
      return out;
    },

    async walk(root: string): Promise<Map<string, SnmpValue>> {
      walked.push(root);
      if (options.walkFails?.includes(root)) throw new Error(`parcours refusé sur ${root}`);
      const out = new Map<string, SnmpValue>();
      for (const [oid, value] of Object.entries(values)) {
        if (oid.startsWith(`${root}.`)) out.set(oid, value);
      }
      return out;
    },
  };
}

/** Un hôte injoignable : toute requête échoue, comme une machine éteinte. */
export function unreachableHost(message = 'injoignable'): NasSnmpSource {
  return {
    async get(): Promise<Map<string, SnmpValue>> {
      throw new Error(message);
    },
    async walk(): Promise<Map<string, SnmpValue>> {
      throw new Error(message);
    },
  };
}
