import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { FAILURES_BEFORE_VERDICT } from '../../lib/device/rhythm.mjs';
import { PortContactTracker } from '../../lib/netswitch/contact.mjs';
import { UNKNOWN_LIVE } from '../../lib/netswitch/port.mjs';

const LIVE = { ...UNKNOWN_LIVE, link: 'up' as const };

test('un échec isolé est absorbé : un paquet UDP perdu ne fait pas clignoter la fiche', () => {
  const contact = new PortContactTracker();
  contact.succeeded(LIVE);
  for (let i = 1; i < FAILURES_BEFORE_VERDICT; i += 1) {
    const outcome = contact.failed();
    assert.equal(outcome.absorbing, true, `échec ${i} devrait être absorbé`);
    assert.equal(outcome.availability, 'available');
  }
});

test('au seuil, l\'appareil devient indisponible', () => {
  const contact = new PortContactTracker();
  for (let i = 1; i < FAILURES_BEFORE_VERDICT; i += 1) contact.failed();
  const verdict = contact.failed();
  assert.equal(verdict.absorbing, false);
  assert.equal(verdict.availability, 'unavailable');
  assert.equal(verdict.failures, FAILURES_BEFORE_VERDICT);
});

test('🔴 un relevé raté ne porte aucune mesure : « n\'écris rien », pas « écris du vide »', () => {
  // Écrire un `PortLive` vide ferait tomber le lien à chaque échec, et déclencherait
  // les Flows de coupure.
  assert.equal(new PortContactTracker().failed().live, null);
});

test('un succès remet le compteur à zéro', () => {
  const contact = new PortContactTracker();
  contact.failed();
  contact.failed();
  const back = contact.succeeded(LIVE);
  assert.equal(back.failures, 0);
  assert.equal(back.availability, 'available');
  assert.equal(back.live, LIVE);
  assert.equal(contact.failed().absorbing, true, 'le compteur repart bien de zéro');
});

test('reset abandonne les échecs d\'une conversation qui n\'existe plus', () => {
  const contact = new PortContactTracker();
  for (let i = 0; i < FAILURES_BEFORE_VERDICT; i += 1) contact.failed();
  contact.reset();
  assert.equal(contact.consecutiveFailures, 0);
  assert.equal(contact.failed().absorbing, true);
});
