import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  alarmParts,
  nutFlagParts,
  renderAlarmSummary,
  type AlarmSummaryInput,
  type LocalisedText,
} from '../../lib/ups/alarm-summary.mjs';

/**
 * Ce fichier vérifie deux choses distinctes, et cette séparation est le sujet.
 *
 * 🔴 Les libellés étaient écrits **en français en dur** dans une app publiée en anglais,
 * en français et en néerlandais. Un anglophone lisait « ventilateur en panne », au moment
 * précis où la clarté compte le plus. Rien ne pouvait le voir : une chaîne est une chaîne.
 *
 * `alarmParts` décide **ce qui** ne va pas et dans quel ordre — c'est du domaine, sans
 * langue. `renderAlarmSummary` le dit dans **une** langue. Les tests de tri et de bornes
 * portent donc sur la structure, ceux de formulation sur le rendu.
 */

/** Un traducteur de test, aussi bête que `homey.__` : il choisit une langue. */
const into = (lang: keyof LocalisedText) => (text: LocalisedText) => text[lang];
const render = (input: AlarmSummaryInput, lang: keyof LocalisedText = 'fr') => {
  const summary = alarmParts(input);
  return summary === null ? null : renderAlarmSummary(summary, into(lang));
};

test('un onduleur sain ne dit rien, et rend null plutôt qu’une structure vide', () => {
  // Une capability sans valeur ne doit pas être déclarée : un champ vide en permanence
  // sur un onduleur qui va bien n'apprend rien et occupe la tuile.
  assert.equal(alarmParts({}), null);
  assert.equal(alarmParts({ named: [], texts: [], foreign: 0 }), null);
  assert.equal(alarmParts({ texts: ['', '   ', null, undefined] }), null);
});

test('🔴 la même alarme se dit dans les trois langues', () => {
  const input: AlarmSummaryInput = { named: ['fanFailure'] };
  assert.equal(render(input, 'en'), 'fan failed');
  assert.equal(render(input, 'fr'), 'ventilateur en panne');
  assert.equal(render(input, 'nl'), 'ventilator defect');
});

test('🔴 aucun libellé ne manque à aucune des trois langues', () => {
  // Une traduction oubliée ne se verrait pas : elle rendrait `undefined`, donc « undefined »
  // affiché sur la tuile. Le parcours part des alarmes réellement définies.
  const every = alarmParts({
    named: ['shutdownImminent', 'upsSystemOff', 'upsOutputOff', 'depletedBattery',
      'shutdownPending', 'onBypass', 'bypassBad', 'outputBad', 'outputOverload',
      'generalFault', 'fanFailure', 'fuseFailure', 'chargerFailed', 'batteryBad',
      'tempBad', 'lowBattery', 'onBattery', 'inputBad', 'awaitingPower',
      'communicationsLost', 'diagnosticTestFailed', 'testInProgress',
      'outputOffAsRequested', 'upsOffAsRequested'],
    parts: nutFlagParts(['FSD', 'OFF', 'BYPASS', 'HB', 'CAL', 'TRIM', 'BOOST', 'CHRG']),
  })!;

  for (const part of every.parts) {
    if (part.kind !== 'named') continue;
    for (const lang of ['en', 'fr', 'nl'] as const) {
      const text = part.text[lang];
      assert.ok(typeof text === 'string' && text.length > 0, `${lang} manquant`);
    }
  }
});

test('🔴 le tri suit la gravité, pas l’ordre de la table de l’agent', () => {
  // L'agent rend ses alarmes dans SON ordre ; l'utilisateur lit la première.
  const summary = render({ named: ['batteryBad', 'shutdownImminent', 'onBattery'] })!;
  assert.ok(summary.startsWith('arrêt imminent'), summary);

  // Et un défaut matériel passe avant un état en cours. Ce n'est pas un détail : « sur
  // batterie » a déjà sa capability booléenne et son déclencheur de Flow, donc ce texte
  // sert surtout à dire ce que les booléens ne disent pas. Une batterie à remplacer
  // signifie que la prochaine coupure ne sera pas couverte.
  assert.ok(summary.indexOf('batterie à remplacer') < summary.indexOf('sur batterie'), summary);
});

test('🔴 le résumé est borné : une douzaine d’alarmes ne fait pas un paragraphe', () => {
  const input: AlarmSummaryInput = {
    named: ['shutdownImminent', 'upsSystemOff', 'onBypass', 'outputBad', 'fanFailure',
      'fuseFailure', 'chargerFailed', 'batteryBad', 'tempBad', 'onBattery'],
  };
  const summary = render(input)!;
  assert.ok(summary.length <= 200, `${summary.length} caractères`);
  assert.ok(summary.includes('+5 autres'), summary);
  assert.ok(summary.startsWith('arrêt imminent'), 'et le plus grave reste en tête');

  // 🔴 La borne s'applique **par langue**. Elle est vérifiée au rendu et non sur la
  // structure, précisément parce que « uitschakeling ophanden » et « shutdown imminent »
  // ne coupent pas au même endroit : trancher en amont donnerait une phrase correcte en
  // français et une phrase coupée en plein mot en néerlandais.
  for (const lang of ['en', 'nl'] as const) {
    assert.ok(render(input, lang)!.length <= 200, lang);
  }
});

test('une alarme qu’on ne sait pas nommer est annoncée quand même', () => {
  // Un constructeur définit ses alarmes sous sa propre PEN. Les taire serait pire que
  // de les annoncer sans leur nom : l'utilisateur croirait que tout va bien.
  assert.equal(render({ foreign: 1 }), '1 alarme constructeur');
  assert.equal(render({ foreign: 3 }), '3 alarmes constructeur');
  assert.equal(render({ foreign: 3 }, 'en'), '3 vendor alarms');
  assert.equal(render({ foreign: 3 }, 'nl'), '3 fabrikantalarmen');
});

test('la troncature annoncée par l’agent est reportée', () => {
  assert.equal(render({ named: ['onBattery'], truncated: true }), 'sur batterie · +1 autre');
  assert.equal(render({ named: ['onBattery'], truncated: true }, 'en'), 'on battery · +1 more');
});

test('les textes déjà en clair passent tels quels, sans doublon', () => {
  // Ni traduits ni réécrits : c'est le firmware qui parle. Le doublon, lui, ferait douter
  // du reste de la phrase.
  assert.equal(
    render({ texts: ['bypass logiciel', 'bypass logiciel', 'batterie faible'] }),
    'bypass logiciel · batterie faible',
  );
});

test('noms RFC et textes constructeur cohabitent, les noms d’abord', () => {
  const summary = render({ named: ['onBattery'], texts: ['correction de tension basse'] })!;
  assert.ok(summary.startsWith('sur batterie'), summary);
  assert.ok(summary.includes('correction de tension basse'), summary);
});

// ---------------------------------------------------------------------------
// Les jetons NUT que les quatre booléens ne savent pas exprimer.
// ---------------------------------------------------------------------------

test('🔴 une coupure ordinaire ne dit rien : les booléens la disent déjà', () => {
  // `OB`, `LB` et `DISCHRG` ont chacun leur capability et leur déclencheur. Les répéter
  // en texte encombrerait la tuile sans rien apprendre.
  assert.equal(alarmParts({ parts: nutFlagParts(['OB', 'DISCHRG', 'LB']) }), null);
});

test('🔴 un onduleur en bypass ne protège plus rien, et rien d’autre ne le dit', () => {
  // Sans ce libellé, `OL BYPASS` est indiscernable d'un onduleur sain : le secteur est
  // là, aucune alarme booléenne ne se lève, et la charge n'est pourtant plus protégée.
  assert.equal(render({ parts: nutFlagParts(['OL', 'BYPASS']) }),
    'sur bypass, charge non protégée');
  assert.equal(render({ parts: nutFlagParts(['OL', 'BYPASS']) }, 'en'),
    'on bypass, load unprotected');
});

test('une calibration programmée se distingue d’une coupure', () => {
  assert.equal(render({ parts: nutFlagParts(['OL', 'DISCHRG', 'CAL']) }), 'calibration en cours');
});

test('un jeton NUT inconnu remonte brut plutôt que d’être tu', () => {
  // Et il remonte **identique** dans les trois langues : l'app ne sait pas ce qu'il veut
  // dire, donc elle n'a rien à en traduire.
  for (const lang of ['en', 'fr', 'nl'] as const) {
    assert.equal(render({ parts: nutFlagParts(['OL'], ['WEIRDFLAG']) }, lang), 'WEIRDFLAG');
  }
});

test('🔴 la même alarme vue par deux sources ne se dit qu’une fois', () => {
  // `onBypass` peut venir du bit de la RFC **et** du jeton NUT `BYPASS`. La dire deux
  // fois ferait douter du reste de la phrase.
  const summary = render({ named: ['onBypass'], parts: nutFlagParts(['BYPASS']) })!;
  assert.equal(summary, 'sur bypass, charge non protégée');
});
