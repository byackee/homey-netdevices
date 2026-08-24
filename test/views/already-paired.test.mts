/**
 * 🔴 « Aucun appareil trouvé » quand le seul onduleur du réseau est déjà ajouté.
 *
 * Signalé par un utilisateur (Jeroen6, forum Homey, v1.0.8) : le balayage annonçait
 * n'avoir rien trouvé, pendant que le journal de l'app disait avoir reconnu un onduleur.
 * Il a redémarré l'app, en vain — et pour cause, les deux affirmations étaient vraies.
 *
 * Le balayage reconnaît bien l'onduleur : `sweepProbe` le trace, `onFound` le range dans
 * `state.found`. C'est `scan_status` qui le retire ensuite, et à bon droit :
 *
 *     .filter((finding) => !taken.has(finding.host))
 *
 * On n'offre pas d'ajouter un appareil déjà ajouté. Le défaut n'est pas là : il est dans
 * ce que la vue conclut d'une liste vide. Elle appelle `showHelp()`, qui affiche « SNMP
 * works here, but no UPS answered » et explique comment activer le SNMP — sur un
 * onduleur qui répond parfaitement et qui est déjà dans Homey.
 *
 * Le coût n'est pas cosmétique : on envoie quelqu'un réparer ce qui marche, et on lui
 * cache la seule information vraie, à savoir qu'il n'y a rien de plus à ajouter.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import { FakeHomey, Stage, parseView, settle } from './dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const START_HTML = readFileSync(path.join(ROOT, 'drivers/ups/pair/start.html'), 'utf8');
parseView(START_HTML);

/** Un balayage qui se termine avec la réponse donnée. */
function sweep(final: Record<string, unknown>): Record<string, (data: unknown) => unknown> {
  let polls = 0;
  return {
    scan_start: () => ({ started: true, subnet: '192.168.93', total: 254 }),
    scan_status: () => {
      polls += 1;
      if (polls === 1) return { running: true, done: 40, total: 254, error: null, found: [], others: [] };
      return {
        running: false, done: 254, total: 254, error: null,
        found: [], others: [], reachable: [], ...final,
      };
    },
  };
}

async function run(final: Record<string, unknown>): Promise<Stage> {
  const stage = new Stage(new FakeHomey({ handlers: sweep(final) }));
  stage.load(START_HTML, 'start.html');
  await settle();
  return stage;
}

/** Tout ce que la vue a fini par écrire à l'écran. */
function ecran(stage: Stage): string {
  return `${stage.el('ups-start-status').textContent}\n${stage.el('ups-start-help').textContent}`;
}

describe('le balayage ne trouve rien parce que tout est déjà ajouté', () => {
  test('🔴 la vue ne doit pas prétendre qu’aucun onduleur n’a répondu', async () => {
    const stage = await run({ alreadyPaired: 1 });
    const texte = ecran(stage);

    assert.doesNotMatch(
      texte,
      /Nothing answered over SNMP|still switched off/i,
      'la vue envoie l’utilisateur activer le SNMP sur un onduleur qui répond et qui est déjà ajouté :\n'
      + texte,
    );
  });

  test('🔴 elle doit dire que l’onduleur trouvé est déjà ajouté', async () => {
    const stage = await run({ alreadyPaired: 1 });
    assert.match(
      ecran(stage),
      /already added|already in Homey|déjà ajouté/i,
      'rien ne dit à l’utilisateur pourquoi la liste est vide',
    );
  });

  test('deux onduleurs déjà ajoutés se comptent', async () => {
    const stage = await run({ alreadyPaired: 2 });
    assert.match(ecran(stage), /2/, 'le nombre trouvé n’est pas rapporté');
  });

  test('sans rien de déjà appairé, l’aide d’origine reste la bonne réponse', async () => {
    // Le cas légitime : le balayage n'a vraiment rien vu. C'est là — et là seulement —
    // que « activez le SNMP » est le conseil juste.
    const stage = await run({ alreadyPaired: 0, others: [] });
    assert.match(ecran(stage), /SNMP/i, 'l’aide d’origine a disparu du cas où elle est utile');
  });
});
