import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ANY_LINK, LinkChangeDetector, matchesLinkFilter, type ObservablePort } from '../../lib/netswitch/link-change.mjs';
import type { LinkState } from '../../lib/netswitch/if-mib.mjs';
import type { PoeStatus } from '../../lib/netswitch/poe-mib.mjs';

function port(link: LinkState, poe: PoeStatus | null = null): ObservablePort {
  return { link, poe: poe === null ? null : { status: poe } };
}

test('🔴 le premier relevé ne déclenche rien', () => {
  // Sinon, tous les ports éteints de la maison déclencheraient « le lien est tombé » à
  // chaque redémarrage de Homey.
  const detector = new LinkChangeDetector();
  const change = detector.observe(port('down'));
  assert.equal(change.wentDown, false);
  assert.equal(change.linkChanged, false);
  assert.equal(change.link, 'down', 'l\'état courant est tout de même rapporté');
});

test('🔴 un franchissement, pas un état : rester éteint ne redéclenche rien', () => {
  const detector = new LinkChangeDetector();
  detector.observe(port('up'));
  assert.equal(detector.observe(port('down')).wentDown, true);
  assert.equal(detector.observe(port('down')).wentDown, false);
  assert.equal(detector.observe(port('down')).wentDown, false);
});

test('🔴 « inconnu » n\'est pas une chute : un paquet SNMP perdu ne coupe pas un câble', () => {
  const detector = new LinkChangeDetector();
  detector.observe(port('up'));
  const lost = detector.observe(port('unknown'));
  assert.equal(lost.wentDown, false);
  assert.equal(lost.linkChanged, false);

  // Et le retour ne doit pas non plus se lire comme un branchement.
  const back = detector.observe(port('up'));
  assert.equal(back.cameUp, false);
});

test('un branchement déclenche « le lien s\'active », une seule fois', () => {
  const detector = new LinkChangeDetector();
  detector.observe(port('down'));
  const up = detector.observe(port('up'));
  assert.equal(up.cameUp, true);
  assert.equal(up.linkChanged, true);
  assert.equal(detector.observe(port('up')).cameUp, false);
});

test('lowerLayerDown est une chute comme une autre', () => {
  const detector = new LinkChangeDetector();
  detector.observe(port('up'));
  const change = detector.observe(port('lowerLayerDown'));
  assert.equal(change.wentDown, true);
  assert.equal(change.link, 'lowerLayerDown', 'le sélecteur de la carte reçoit l\'état exact');
});

test('un défaut PoE se déclenche au passage, pas tant qu\'il dure', () => {
  const detector = new LinkChangeDetector();
  detector.observe(port('up', 'delivering'));
  assert.equal(detector.observe(port('up', 'fault')).poeFaultRaised, true);
  assert.equal(detector.observe(port('up', 'fault')).poeFaultRaised, false);
  assert.equal(detector.observe(port('up', 'delivering')).poeFaultRaised, false);
  assert.equal(detector.observe(port('up', 'otherFault')).poeFaultRaised, true);
});

test('un port sans PoE ne déclenche jamais de défaut PoE', () => {
  const detector = new LinkChangeDetector();
  detector.observe(port('up', null));
  assert.equal(detector.observe(port('up', null)).poeFaultRaised, false);
});

test('reset oublie l\'état d\'avant : une nouvelle adresse est un autre appareil', () => {
  const detector = new LinkChangeDetector();
  detector.observe(port('up'));
  detector.reset();
  assert.equal(detector.observe(port('down')).wentDown, false);
});

test('le filtre « n\'importe lequel » couvre aussi l\'argument absent', () => {
  // Une carte posée avant que l'argument existe ne doit pas cesser silencieusement de
  // se déclencher.
  assert.equal(matchesLinkFilter(ANY_LINK, 'down'), true);
  assert.equal(matchesLinkFilter(undefined, 'down'), true);
  assert.equal(matchesLinkFilter(null, 'down'), true);
  assert.equal(matchesLinkFilter('', 'down'), true);
  assert.equal(matchesLinkFilter('down', 'down'), true);
  assert.equal(matchesLinkFilter('up', 'down'), false);
});
