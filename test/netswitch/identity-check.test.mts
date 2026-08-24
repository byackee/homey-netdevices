import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { comparePortIdentity } from '../../lib/netswitch/identity-check.mjs';

/**
 * 🔴 Le seul garde-fou entre « je vise le port qu'on m'a désigné » et « je vise l'index
 * que j'avais noté ».
 *
 * L'index d'un port n'est pas stable : un switch qui redémarre peut renuméroter ses
 * interfaces. En lecture, le dépôt le savait déjà — les courbes deviennent fausses. En
 * écriture, la conséquence change de nature : **on coupe le mauvais port**.
 *
 * Le réalignement n'a lieu qu'au relevé lent, 300 s par défaut et jusqu'à 24 h selon le
 * réglage. Pendant tout cet intervalle, rien d'autre ne protégeait : ni le transport ni
 * l'agent, puisqu'une écriture bien formée sur un OID valide qui vise le mauvais port
 * **réussit** et remonte comme un succès.
 */

test('🔴 un port renuméroté est détecté, et c’est le seul cas qui refuse', () => {
  assert.equal(
    comparePortIdentity({ ifName: 'Gi0/5', ifDescr: null }, { ifName: 'Gi0/9', ifDescr: null }),
    'changed',
  );
});

test('le même port se reconnaît', () => {
  assert.equal(
    comparePortIdentity({ ifName: 'Gi0/5', ifDescr: 'GigabitEthernet0/5' },
                        { ifName: 'Gi0/5', ifDescr: 'GigabitEthernet0/5' }),
    'same',
  );
});

test('🔴 `ifName` prime sur `ifDescr`, qu’un firmware réécrit d’une version à l’autre', () => {
  // Le nom court de l'ifXTable est stable ; la description porte parfois un libellé que
  // la mise à jour du firmware reformule. Se fier à la description ferait refuser des
  // écritures parfaitement légitimes après chaque mise à jour du switch.
  assert.equal(
    comparePortIdentity(
      { ifName: 'Gi0/5', ifDescr: 'GigabitEthernet0/5' },
      { ifName: 'Gi0/5', ifDescr: 'GigabitEthernet 0/5 (uplink)' },
    ),
    'same',
  );
});

test('à défaut de `ifName`, la description fait foi', () => {
  // `ifName` vient d'une table optionnelle ; `ifDescr` est obligatoire dans l'ifTable.
  assert.equal(
    comparePortIdentity({ ifName: null, ifDescr: 'GigabitEthernet0/5' },
                        { ifName: null, ifDescr: 'GigabitEthernet0/9' }),
    'changed',
  );
});

test('🔴 sans rien à comparer, l’écriture passe — on n’invente pas un refus', () => {
  // Deux cas réels : un appareil créé par une version antérieure qui n'avait rien retenu,
  // et un agent qui ne rend ni nom ni description. Refuser ici priverait de la commande
  // des appareils qui n'ont rien fait de mal ; le doute ne profite au refus que lorsqu'on
  // a une **preuve** de divergence.
  assert.equal(comparePortIdentity({ ifName: null, ifDescr: null },
                                   { ifName: 'Gi0/5', ifDescr: 'GigabitEthernet0/5' }), 'unknown');
  assert.equal(comparePortIdentity({ ifName: 'Gi0/5', ifDescr: 'GigabitEthernet0/5' },
                                   { ifName: null, ifDescr: null }), 'unknown');
});

test('l’espacement seul ne fait pas un port différent', () => {
  assert.equal(
    comparePortIdentity({ ifName: ' Gi0/5 ', ifDescr: null }, { ifName: 'Gi0/5', ifDescr: null }),
    'same',
  );
  assert.equal(
    comparePortIdentity({ ifName: null, ifDescr: 'Gigabit  Ethernet 0/5' },
                        { ifName: null, ifDescr: 'Gigabit Ethernet 0/5' }),
    'same',
  );
});

test('une chaîne vide vaut une absence, pas une divergence', () => {
  // Un agent qui rend `""` pour ifName ne dit pas « ce port a changé de nom ».
  assert.equal(
    comparePortIdentity({ ifName: 'Gi0/5', ifDescr: 'GigabitEthernet0/5' },
                        { ifName: '', ifDescr: 'GigabitEthernet0/5' }),
    'same',
  );
});
