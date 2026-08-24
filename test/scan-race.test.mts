import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 🔴 Le drapeau du balayage doit se poser avant le premier point d'attente.
 *
 * `startScan` teste `this.scan.running` puis, s'il est libre, lance un parcours. Entre le
 * test et la pose du drapeau vivait un `await` : deux déclencheurs quasi simultanés — la
 * page de réglages qui lance un balayage pendant qu'une vue de pairing en demande un, ou
 * simplement deux vues ouvertes — passaient tous deux le test et démarraient deux
 * parcours. Quarante-huit sockets UDP au lieu de vingt-quatre, sur une Homey qui n'a
 * qu'un nombre fini de descripteurs, et le second écrasait l'accumulateur du premier.
 *
 * Ce garde est statique parce qu'il ne peut pas être autre chose : la classe `App` de
 * Homey ne s'instancie dans aucun test, comme `Device`. Le compilateur ne voit rien —
 * un `await` mal placé est du code parfaitement typé — et la course ne se reproduit que
 * sous un enchaînement précis, donc un test dynamique la manquerait la plupart du temps.
 */
test('🔴 startScan pose son drapeau avant tout await', () => {
  const source = readFileSync(join(process.cwd(), 'app.mts'), 'utf8');

  const debut = source.indexOf('async startScan(');
  assert.ok(debut > 0, 'startScan introuvable — ce test ne prouverait rien');

  // Le corps s'arrête à la première méthode suivante, repérée par son indentation.
  const suite = source.indexOf('\n  private ', debut);
  const fin = suite > 0 ? suite : source.length;
  const corps = source.slice(debut, fin);

  const poseDrapeau = corps.indexOf('running: true');
  const premierAwait = corps.indexOf('await ');

  assert.ok(poseDrapeau > 0, 'startScan doit poser `running: true`');
  assert.ok(
    premierAwait < 0 || poseDrapeau < premierAwait,
    'le drapeau se pose après un `await` : deux appels simultanés lanceraient deux balayages',
  );
});

test('🔴 le drapeau est relâché si le démarrage échoue', () => {
  // Poser le drapeau tôt oblige à le relâcher sur les chemins de sortie, sans quoi une
  // erreur au démarrage bloquerait tout balayage ultérieur jusqu'au redémarrage de l'app.
  const source = readFileSync(join(process.cwd(), 'app.mts'), 'utf8');
  const debut = source.indexOf('async startScan(');
  const suite = source.indexOf('\n  private ', debut);
  const corps = source.slice(debut, suite > 0 ? suite : source.length);

  assert.match(corps, /catch|finally/, 'aucun rattrapage : un échec laisserait le drapeau levé');
  assert.match(corps, /running: false/, 'le drapeau doit pouvoir redescendre');
});
