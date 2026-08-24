import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Les deux règles de disponibilité que le compilateur ne peut pas tenir.
 *
 * Ces gardes sont statiques faute de mieux : la classe `Device` de Homey ne s'instancie
 * dans aucun test, `applyOutcome` est privée, et les deux défauts visés sont du code
 * parfaitement typé. Ils ne se voient qu'à l'exécution, sur un vrai Homey, dans un état
 * — appareil injoignable — qu'on ne traverse pas en développement.
 */

const DRIVERS = ['ups', 'nas', 'netswitch'] as const;

function source(driver: string): string {
  return readFileSync(join(process.cwd(), 'drivers', driver, 'device.mts'), 'utf8');
}

/** Le corps d'une méthode, de sa signature à l'accolade fermante de son niveau. */
function corpsDe(texte: string, signature: string): string {
  const debut = texte.indexOf(signature);
  assert.ok(debut > 0, `${signature} introuvable — ce test ne prouverait rien`);
  const fin = texte.indexOf('\n  }\n', debut);
  assert.ok(fin > debut, `${signature} : fin de corps introuvable`);
  return texte.slice(debut, fin);
}

// ---------------------------------------------------------------------------
// 1. La disponibilité se règle avant l'écriture
// ---------------------------------------------------------------------------

/**
 * 🔴 Athom documente qu'un appareil indisponible voit « all capabilities and Flow actions »
 * empêchées. Mesuré sur Homey Pro 2023, ce blocage ne porte aujourd'hui que sur le sens
 * entrant : une écriture de l'app pendant l'indisponibilité passe et atteint le cœur.
 *
 * On ne s'appuie pas là-dessus. Si ce comportement se resserre un jour sur le contrat
 * écrit, l'ordre inverse perdrait le **premier** relevé de chaque retour de contact —
 * celui qui annonce que la machine est revenue — et le suivant n'arriverait qu'un cycle
 * plus tard : dix secondes sur l'onduleur, mais jusqu'à quinze minutes sur le rythme lent
 * du NAS. Une perte silencieuse, invisible en validation comme au typage.
 */
for (const driver of DRIVERS) {
  test(`🔴 ${driver} : applyAvailability passe avant writeValues`, () => {
    const corps = corpsDe(source(driver), 'private async applyOutcome(');

    const disponibilite = corps.indexOf('this.applyAvailability(');
    const ecriture = corps.indexOf('this.writeValues(');

    assert.ok(disponibilite > 0, `${driver} : applyOutcome doit régler la disponibilité`);
    assert.ok(ecriture > 0, `${driver} : applyOutcome doit écrire les valeurs`);
    assert.ok(
      disponibilite < ecriture,
      `${driver} : les valeurs s'écrivent avant que l'appareil soit rendu disponible — `
      + 'le premier relevé du retour de contact repose sur une tolérance non documentée',
    );
  });
}

// ---------------------------------------------------------------------------
// 2. `setUnavailable()` exige toujours un message
// ---------------------------------------------------------------------------

/**
 * 🔴 `setUnavailable()` sans message ne fait **rien** sur Homey Pro 2023, sans lever.
 *
 * C'est un défaut confirmé par Athom : athombv/homey-apps-sdk-issues#313. Le repli qui
 * fournissait un message par défaut existait sur l'ancienne Homey Pro et n'est jamais
 * posé sur celle de 2023 (« we had a fallback for the old homey pro and in 2023 this
 * fallback is never set »). Le typage l'autorise — le paramètre est optionnel — et la
 * validation ne dit rien. L'appareil resterait donc disponible en annonçant des mesures
 * figées, ce qui est exactement le mensonge que la disponibilité sert à éviter.
 *
 * `null` est aussi refusé ici : la doc le présente comme « message par défaut », et c'est
 * précisément ce repli-là qui n'existe plus.
 */
test('🔴 aucun setUnavailable() sans message', () => {
  const creux = /setUnavailable\s*\(\s*(?:\)|null\s*\)|undefined\s*\))/g;

  const fautifs: string[] = [];
  for (const driver of DRIVERS) {
    for (const [index, ligne] of source(driver).split('\n').entries()) {
      if (creux.test(ligne)) fautifs.push(`drivers/${driver}/device.mts:${index + 1} — ${ligne.trim()}`);
      creux.lastIndex = 0;
    }
  }

  assert.deepEqual(
    fautifs,
    [],
    'setUnavailable() sans message est un no-op silencieux sur Homey Pro 2023 (SDK issue #313) :\n'
    + `${fautifs.join('\n')}`,
  );
});

/** Le garde ne vaut que s'il y a bien des appels à surveiller. */
test('chaque driver marque réellement son appareil indisponible', () => {
  for (const driver of DRIVERS) {
    const appels = source(driver).match(/setUnavailable\s*\(/g) ?? [];
    assert.ok(
      appels.length > 0,
      `${driver} : plus aucun setUnavailable — le garde ci-dessus ne prouverait plus rien`,
    );
  }
});
