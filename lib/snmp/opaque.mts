/**
 * Décodage du flottant `Opaque` propriétaire de Net-SNMP.
 *
 * Certains agents — Synology au premier chef — publient leurs mesures avec le type
 * `Float` importé de `NET-SNMP-TC`. Sur le fil ce n'est pas un entier : c'est un
 * ASN.1 `Opaque` portant une extension propriétaire Net-SNMP.
 *
 * `net-snmp` ne décode pas cette extension, il rend les octets bruts. La conversion
 * a lieu ici et non dans le client, délibérément : seul un lecteur sait qu'il attend
 * un flottant sur un OID donné.
 *
 * Disposition (Net-SNMP, `ASN_OPAQUE_FLOAT_BER_LEN = 7`) :
 *
 *     9f 78 04 <4 octets IEEE754 big-endian>    // float  — 123 → 9f78 04 42f60000
 *     9f 79 08 <8 octets IEEE754 big-endian>    // double — rare
 */

const OPAQUE_TAG = 0x9f;
const FLOAT_TYPE = 0x78;
const DOUBLE_TYPE = 0x79;

/**
 * Décode un flottant Opaque Net-SNMP.
 *
 * Rend `null` si le tampon n'en est pas un — jamais une valeur inventée, parce qu'un
 * `0` silencieux ici deviendrait « batterie à 0 % », donc une fausse alarme.
 */
export function decodeOpaqueFloat(buffer: Buffer): number | null {
  if (buffer.length === 7 && buffer[0] === OPAQUE_TAG && buffer[1] === FLOAT_TYPE && buffer[2] === 0x04) {
    return buffer.readFloatBE(3);
  }
  if (buffer.length === 11 && buffer[0] === OPAQUE_TAG && buffer[1] === DOUBLE_TYPE && buffer[2] === 0x08) {
    return buffer.readDoubleBE(3);
  }
  return null;
}

/**
 * Lit une valeur SNMP en nombre, quelle que soit la forme sous laquelle l'agent la rend.
 *
 * Un agent conforme renvoie un entier, Synology un `Opaque Float`, certains une chaîne.
 * `null` reste `null` de bout en bout : une mesure absente ne doit jamais devenir zéro,
 * sous peine de déclencher précisément les alarmes qu'elle devrait taire.
 */
export function toNumber(value: string | number | Buffer | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Buffer.isBuffer(value)) return decodeOpaqueFloat(value);
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
