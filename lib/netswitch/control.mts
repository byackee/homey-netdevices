/**
 * Le garde-fou d'écriture, et le seul endroit du dépôt qui décide qu'un SET est permis.
 *
 * 🔴 **L'écriture est permise, mais désactivée par défaut.** Décision du brief, et elle
 * porte sur un vrai risque : `ifAdminStatus` coupe un port de switch, et
 * `pethPsePortAdminEnable` coupe l'alimentation d'une caméra ou d'un point d'accès. Sur
 * un réseau domestique, le port qu'on coupe est souvent celui qui porte le Homey lui-même
 * — ou le routeur, ou le switch amont. Après quoi il n'y a plus de chemin pour rallumer :
 * il faut aller sur place, avec un câble.
 *
 * D'où la forme de ce fichier : **une fonction pure qui rend soit un refus motivé, soit
 * la liste exacte des varbinds à écrire.** Rien n'émet ici. Le device ne peut donc pas
 * écrire sans être passé par une décision, et cette décision se teste sans réseau — ce
 * qui est le seul moyen d'avoir confiance dans un chemin qu'on ne veut pas exercer en vrai.
 *
 * Le refus est **machine** (`reason`), jamais du texte : la formulation appartient à la
 * couche qui connaît la langue de l'utilisateur, comme pour `outcome` côté pairing.
 */

import { IF_TABLE } from './if-mib.mjs';
import { PETH_PORT_TABLE, poePortOid, truthValue, type PoePortRef } from './poe-mib.mjs';

/** Un varbind à écrire. `integer` couvre les deux cibles : INTEGER et TruthValue. */
export interface PortWrite {
  oid: string;
  type: 'integer';
  value: number;
}

/** Pourquoi une écriture a été refusée. */
export type ControlRefusal =
  /** Le réglage `allow_control` de l'appareil est faux. C'est le cas normal. */
  | 'control-disabled'
  /** L'appareil ne sait pas quel `ifIndex` il vise — inventaire perdu, port disparu. */
  | 'no-port'
  /** Aucune correspondance PoE n'a pu être établie pour ce port. */
  | 'no-poe';

export type ControlDecision =
  | { allowed: false; reason: ControlRefusal }
  | { allowed: true; writes: PortWrite[] };

/** Ce que le device sait de lui-même au moment où une carte de Flow lui demande d'agir. */
export interface ControlContext {
  /** Le réglage `allow_control`. **Faux par défaut**, et faux tant qu'il n'est pas coché. */
  allowControl: boolean;
  /** L'index courant du port, réaligné par `resolvePortIndex()`. `null` = on ne sait plus. */
  ifIndex: number | null;
  /** La prise PoE correspondante, quand la correspondance tient. */
  poe: PoePortRef | null;
}

/**
 * Allumer ou éteindre le port lui-même (`ifAdminStatus`).
 *
 * up(1) / down(2). testing(3) existe dans la MIB et n'est jamais écrit : ce n'est pas
 * un état qu'un utilisateur demande depuis un Flow.
 */
export function planPortPower(context: ControlContext, on: boolean): ControlDecision {
  if (!context.allowControl) return { allowed: false, reason: 'control-disabled' };
  if (context.ifIndex === null) return { allowed: false, reason: 'no-port' };

  return {
    allowed: true,
    writes: [{ oid: `${IF_TABLE.adminStatus}.${context.ifIndex}`, type: 'integer', value: on ? 1 : 2 }],
  };
}

/**
 * Couper ou rétablir l'alimentation PoE d'une prise (`pethPsePortAdminEnable`).
 *
 * Distinct de {@link planPortPower} à dessein, et les deux ne se remplacent pas : couper
 * le PoE éteint l'appareil au bout du câble mais laisse le lien Ethernet configurable ;
 * couper le port coupe les deux. Un utilisateur qui veut redémarrer une caméra veut le
 * premier, et le lui donner sous le même bouton que le second serait un piège.
 *
 * ⚠️ Le TruthValue de SNMPv2 est **true(1) / false(2)** — l'inverse de l'intuition, où
 * zéro serait faux. `truthValue()` porte la conversion, et son test la fixe.
 */
export function planPoePower(context: ControlContext, on: boolean): ControlDecision {
  if (!context.allowControl) return { allowed: false, reason: 'control-disabled' };
  if (context.poe === null) return { allowed: false, reason: 'no-poe' };

  return {
    allowed: true,
    writes: [{
      oid: poePortOid(PETH_PORT_TABLE.adminEnable, context.poe),
      type: 'integer',
      value: truthValue(on),
    }],
  };
}
