/**
 * L'agent SNMP factice partagé par les tests de sources.
 *
 * Deux comportements font tout l'intérêt du montage, et ce sont ceux d'un vrai agent :
 * un OID absent du dictionnaire est **absent de la réponse** — c'est ce que fait un agent
 * qui ne connaît pas l'objet — et la liste des requêtes est conservée, parce que
 * « quel OID a-t-on demandé » est la moitié des bugs de cette couche (index de table à 0,
 * groupe rapide qui embarque des objets lents).
 */

import type { SnmpSource, SnmpValue } from '../../lib/ups/snapshot.mjs';

export interface FakeSnmpSource extends SnmpSource {
  /** Les listes d'OID demandées, dans l'ordre. */
  readonly asked: string[][];
}

export function fakeSource(values: Record<string, SnmpValue>): FakeSnmpSource {
  const asked: string[][] = [];
  return {
    asked,
    async get(oids: string[]): Promise<Map<string, SnmpValue>> {
      asked.push(oids);
      const out = new Map<string, SnmpValue>();
      for (const oid of oids) {
        if (Object.prototype.hasOwnProperty.call(values, oid)) out.set(oid, values[oid]!);
      }
      return out;
    },
  };
}

/** Un agent injoignable : toute requête échoue, comme un hôte éteint. */
export function unreachableSource(message = 'injoignable'): SnmpSource {
  return {
    async get(): Promise<Map<string, SnmpValue>> {
      throw new Error(message);
    },
  };
}
