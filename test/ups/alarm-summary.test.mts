import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nutFlagLabels, summariseAlarms } from '../../lib/ups/alarm-summary.mjs';

test('un onduleur sain ne dit rien, et rend null plutôt qu\'une chaîne vide', () => {
  // Une capability sans valeur ne doit pas être déclarée : un champ vide en permanence
  // sur un onduleur qui va bien n'apprend rien et occupe la tuile.
  assert.equal(summariseAlarms({}), null);
  assert.equal(summariseAlarms({ named: [], texts: [], foreign: 0 }), null);
  assert.equal(summariseAlarms({ texts: ['', '   ', null, undefined] }), null);
});

test('🔴 le tri suit la gravité, pas l\'ordre de la table de l\'agent', () => {
  // L'agent rend ses alarmes dans SON ordre ; l'utilisateur lit la première.
  const summary = summariseAlarms({ named: ['batteryBad', 'shutdownImminent', 'onBattery'] })!;
  assert.ok(summary.startsWith('arrêt imminent'), summary);

  // Et un défaut matériel passe avant un état en cours. Ce n'est pas un détail : « sur
  // batterie » a déjà sa capability booléenne et son déclencheur de Flow, donc ce texte
  // sert surtout à dire ce que les booléens ne disent pas. Une batterie à remplacer
  // signifie que la prochaine coupure ne sera pas couverte — c'est ça qu'il faut lire
  // en premier une fois qu'on sait déjà qu'on est sur batterie.
  assert.ok(summary.indexOf('batterie à remplacer') < summary.indexOf('sur batterie'), summary);
});

test('🔴 le résumé est borné : une douzaine d\'alarmes ne fait pas un paragraphe', () => {
  const summary = summariseAlarms({
    named: ['shutdownImminent', 'upsSystemOff', 'onBypass', 'outputBad', 'fanFailure',
            'fuseFailure', 'chargerFailed', 'batteryBad', 'tempBad', 'onBattery'],
  })!;
  assert.ok(summary.length <= 200, `${summary.length} caractères`);
  assert.ok(summary.includes('+5 autres'), summary);
  assert.ok(summary.startsWith('arrêt imminent'), 'et le plus grave reste en tête');
});

test('une alarme qu\'on ne sait pas nommer est annoncée quand même', () => {
  // Un constructeur définit ses alarmes sous sa propre PEN. Les taire serait pire que
  // de les annoncer sans leur nom : l'utilisateur croirait que tout va bien.
  assert.equal(summariseAlarms({ foreign: 1 }), '1 alarme constructeur');
  assert.equal(summariseAlarms({ foreign: 3 }), '3 alarmes constructeur');
});

test('la troncature annoncée par l\'agent est reportée', () => {
  const summary = summariseAlarms({ named: ['onBattery'], truncated: true })!;
  assert.ok(summary.includes('+1 autre'), summary);
});

test('les textes déjà en clair passent tels quels, sans doublon', () => {
  const summary = summariseAlarms({ texts: ['bypass logiciel', 'bypass logiciel', 'batterie faible'] })!;
  assert.equal(summary, 'bypass logiciel · batterie faible');
});

test('noms RFC et textes constructeur cohabitent, les noms d\'abord', () => {
  const summary = summariseAlarms({ named: ['onBattery'], texts: ['correction de tension basse'] })!;
  assert.ok(summary.startsWith('sur batterie'), summary);
  assert.ok(summary.includes('correction de tension basse'), summary);
});

// ---------------------------------------------------------------------------
// Les jetons NUT que les quatre booléens ne savent pas exprimer.
// ---------------------------------------------------------------------------

test('🔴 une coupure ordinaire ne dit rien : les booléens la disent déjà', () => {
  // `OB`, `LB` et `DISCHRG` ont chacun leur capability et leur déclencheur. Les répéter
  // en texte encombrerait la tuile sans rien apprendre.
  assert.equal(summariseAlarms({ texts: nutFlagLabels(['OB', 'DISCHRG', 'LB']) }), null);
});

test('🔴 un onduleur en bypass ne protège plus rien, et rien d\'autre ne le dit', () => {
  // Sans ce libellé, `OL BYPASS` est indiscernable d'un onduleur sain : le secteur est
  // là, aucune alarme booléenne ne se lève, et la charge n'est pourtant plus protégée.
  assert.equal(summariseAlarms({ texts: nutFlagLabels(['OL', 'BYPASS']) }),
    'sur bypass, charge non protégée');
});

test('une calibration programmée se distingue d\'une coupure', () => {
  assert.equal(summariseAlarms({ texts: nutFlagLabels(['OL', 'DISCHRG', 'CAL']) }),
    'calibration en cours');
});

test('un jeton NUT inconnu remonte brut plutôt que d\'être tu', () => {
  assert.equal(summariseAlarms({ texts: nutFlagLabels(['OL'], ['WEIRDFLAG']) }), 'WEIRDFLAG');
});
