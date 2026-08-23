/**
 * La vue de pairing du switch, exécutée.
 *
 * 🔴 Pourquoi cette suite existe. Neuf pannes de pairing ont coûté trois apps, et AUCUNE
 * n'était détectable par les garde-fous du projet : `npm test` n'exécute pas de HTML,
 * `homey app validate` ne lit pas le JavaScript des vues, et le SDK type les résultats de
 * pairing `any[]` — donc le compilateur ne voit pas passer la clé en trop qui vide la
 * liste. Aucune de ces neuf pannes n'émettait le moindre message d'erreur.
 *
 * Cette vue-ci ajoute une panne que l'onduleur n'avait pas : elle crée **plusieurs**
 * appareils. Tout ce qui compte mal, adopte deux fois, ou s'arrête au milieu sans le dire
 * y est une panne muette de plus.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import {
  FakeHomey, Stage, parseView, plain, settle, stripComments,
  type FakeHomeyOptions, type ParsedView,
} from '../views/dom.mjs';

/** `.testbuild/test/netswitch` → la racine du dépôt. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const HTML = readFileSync(path.join(ROOT, 'drivers/netswitch/pair/start.html'), 'utf8');
const PARSED: ParsedView = parseView(HTML);
const CODE = PARSED.scripts.map(stripComments).join('\n');

const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, 'drivers/netswitch/driver.compose.json'), 'utf8'),
) as { pair?: Array<Record<string, unknown>>; repair?: Array<Record<string, unknown>> };

/** Les seules clés qu'un résultat de pairing admet. Toute autre vide la liste. */
const ALLOWED_KEYS = [
  'name', 'data', 'store', 'settings', 'icon', 'capabilities', 'capabilitiesOptions',
];

/**
 * Deux ports tels que le driver les rapporte.
 *
 * `device` est la charge utile assemblée par `lib/netswitch/pairing.mts`. Elle est
 * reproduite ici à l'identique parce que ce que ces tests vérifient, c'est que la vue la
 * fait PASSER telle quelle — pas qu'elle sait la reconstruire.
 */
function portRow(index: number, name: string, linkUp: boolean, paired = false) {
  return {
    id: `netswitch:serial:foc1:port:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label: name,
    detail: linkUp ? 'link up · 1000 Mbit/s' : 'link down',
    linkUp,
    paired,
    device: {
      name: `sw-garage · ${name}`,
      data: { id: `netswitch:serial:foc1:port:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
      store: { switchKey: 'serial:foc1', ifIndex: index, ifName: name, ifDescr: null, poeGroup: null, poePort: null },
      settings: { host: '192.168.1.2', community: 'public', version: 'v2c' },
      capabilities: ['netswitch_link', 'netswitch_speed'],
    },
  };
}

const PORTS = [portRow(1, 'Gi1/0/1', true), portRow(2, 'Gi1/0/2', false), portRow(3, 'Gi1/0/3', true)];

const PORTS_REPLY = {
  outcome: 'ok',
  host: '192.168.1.2',
  name: 'sw-garage',
  description: 'Cisco IOS Software, C2960',
  version: 'v2c',
  looksLikeSwitch: true,
  poe: false,
  ports: PORTS,
};

const DEVICES = [
  { host: '192.168.1.2', name: 'sw-garage', description: 'Cisco IOS Software, C2960' },
  { host: '192.168.1.30', name: 'DiskStation', description: 'Linux DiskStation' },
];

function handlers(overrides: Record<string, (data: unknown) => unknown> = {}) {
  return {
    scan_start: () => ({ started: true, subnet: '192.168.1', total: 254 }),
    scan_status: () => ({ running: false, done: 254, total: 254, subnet: '192.168.1', error: null, devices: DEVICES }),
    ports: () => PORTS_REPLY,
    adopted: () => undefined,
    ...overrides,
  };
}

async function mount(options: FakeHomeyOptions = {}): Promise<Stage> {
  const homey = new FakeHomey({ handlers: handlers(), ...options });
  const stage = new Stage(homey);
  stage.load(HTML, 'netswitch/pair/start.html');
  await settle();
  return stage;
}

/** Ouvre le switch : c'est le préalable de tout ce qui concerne les ports. */
async function openSwitch(stage: Stage): Promise<void> {
  stage.el('nsw-start-devices').children[0]!.dispatch('click');
  await settle();
}

// ---------------------------------------------------------------------------
// Les neuf pannes, sur cette vue
// ---------------------------------------------------------------------------

describe('les pannes muettes du rétro', () => {
  test('panne 1 — aucune vue de pairing n\'inclut /homey.js', () => {
    // C'est la convention des pages de *settings*. En pairing, Homey injecte déjà l'API,
    // et une seconde inclusion écrase la première.
    assert.deepEqual(PARSED.scriptSources, []);
    assert.equal(/homey\.js/.test(CODE), false);
  });

  test('panne 2 — Homey.ready() est le tout premier appel', async () => {
    // L'ordre du texte ne prouve rien : `report()` est défini en haut du fichier et
    // contient un `Homey.emit`. Seul l'ordre d'EXÉCUTION compte.
    const stage = await mount();
    assert.equal(stage.homey.calls[0], 'ready');
    assert.equal(/setTitle/.test(CODE), false, 'setTitle trop tôt tue le script');
  });

  test('panne 3 — onHomeyReady n\'apparaît nulle part', () => {
    // Jamais appelée en pairing : la vue resterait blanche sans un mot.
    assert.equal(/onHomeyReady/.test(CODE), false);
  });

  test('panne 4 — aucun showView/nextView depuis un handler', () => {
    assert.equal(/showView|nextView/.test(CODE), false);
  });

  test('panne 5 — une seule vue custom, qui crée l\'appareil elle-même', () => {
    assert.deepEqual(MANIFEST.pair, [{ id: 'start' }]);
    assert.equal(MANIFEST.repair, undefined, 'aucune vue de réparation n\'est déclarée');
    assert.ok(/Homey\.createDevice/.test(CODE));
    assert.ok(/Homey\.done/.test(CODE));
    assert.equal(/list_devices/.test(CODE), false);
  });

  test('🔴 panne 6 — la charge utile part telle quelle, sans clé en trop', async () => {
    const stage = await mount();
    await openSwitch(stage);
    stage.el('nsw-start-add').dispatch('click');
    await settle();

    assert.ok(stage.homey.created.length > 0, 'aucun appareil créé');
    for (const payload of stage.homey.created) {
      for (const key of Object.keys(payload)) {
        assert.ok(ALLOWED_KEYS.includes(key), `clé interdite passée à createDevice : ${key}`);
      }
    }
    // Et surtout : identique à ce que le driver a donné, pas une reconstruction.
    assert.deepEqual(plain(stage.homey.created[0]), PORTS[0]!.device);
  });

  test('panne 7 — tous les identifiants sont préfixés, et rien ne fuit en global', async () => {
    const stage = await mount();
    assert.deepEqual(stage.globalLeaks(), []);
    for (const id of stage.document.ids()) {
      assert.ok(id.startsWith('nsw-start-') || id.startsWith('tick-'),
        `identifiant non préfixé : ${id}`);
    }
  });

  test('panne 8 — rien n\'est dit avant que la session écoute, quel que soit le chemin', async () => {
    for (const ready of ['sync', 'async', 'throws'] as const) {
      const stage = await mount({ ready });
      assert.deepEqual(stage.homey.lostEmits, [], `chemin ${ready} : la vue a parlé dans le vide`);
      assert.ok(stage.homey.log().includes('view script running'), `chemin ${ready} : la vue n'a pas démarré`);
    }
  });

  test('panne 9 — requête/réponse, jamais de push', () => {
    // La vue interroge ; elle n'écoute aucun événement poussé par la session. Un
    // balayage tombé et un événement jamais arrivé y seraient indiscernables.
    assert.equal(/Homey\.on\s*\(/.test(CODE), false);
    assert.equal(/addListener/.test(CODE), false);
  });
});

// ---------------------------------------------------------------------------
// Ce que cette vue-ci fait de plus : plusieurs appareils
// ---------------------------------------------------------------------------

describe('l\'adoption de plusieurs ports', () => {
  test('les ports dont le lien est actif sont cochés d\'office, les autres non', async () => {
    const stage = await mount();
    await openSwitch(stage);
    // Deux des trois ports ont un lien actif.
    assert.match(stage.el('nsw-start-add').textContent, /2/);
  });

  test('🔴 un appareil par port coché, et un seul', async () => {
    const stage = await mount();
    await openSwitch(stage);
    stage.el('nsw-start-add').dispatch('click');
    await settle();

    assert.equal(stage.homey.created.length, 2, 'deux ports cochés, deux appareils');
    const ids = stage.homey.created.map((payload) => (payload.data as { id: string }).id);
    assert.equal(new Set(ids).size, 2, 'deux identifiants distincts');
    assert.equal(stage.homey.doneCalls, 1, 'l\'assistant se ferme une fois, à la fin');
  });

  test('cocher un port de plus en crée un de plus', async () => {
    const stage = await mount();
    await openSwitch(stage);
    // Le deuxième port, lien inactif, n'est pas coché : on le coche.
    stage.el('nsw-start-ports').children[1]!.dispatch('click');
    await settle();
    stage.el('nsw-start-add').dispatch('click');
    await settle();
    assert.equal(stage.homey.created.length, 3);
  });

  test('décocher tout désactive le bouton plutôt que de créer zéro appareil', async () => {
    const stage = await mount();
    await openSwitch(stage);
    stage.el('nsw-start-ports').children[0]!.dispatch('click');
    stage.el('nsw-start-ports').children[2]!.dispatch('click');
    await settle();
    assert.equal(stage.el('nsw-start-add').disabled, true);

    stage.el('nsw-start-add').dispatch('click');
    await settle();
    assert.equal(stage.homey.created.length, 0);
    assert.equal(stage.homey.doneCalls, 0, 'et l\'assistant ne se ferme pas sur rien');
  });

  test('🔴 un port déjà dans Homey n\'est pas re-proposé', async () => {
    // Le recréer échouerait, ou dédoublerait l'appareil selon la version du SDK.
    const already = { ...PORTS_REPLY, ports: [portRow(1, 'Gi1/0/1', true, true), PORTS[2]!] };
    const stage = await mount({ handlers: handlers({ ports: () => already }) });
    await openSwitch(stage);

    assert.equal(stage.el('nsw-start-ports').children[0]!.disabled, true);
    stage.el('nsw-start-add').dispatch('click');
    await settle();
    assert.equal(stage.homey.created.length, 1, 'seul le port libre est créé');
  });

  test('🔴 une création qui échoue au milieu dit combien ont abouti', async () => {
    // « Ça a échoué » après dix-sept créations réussies enverrait l'utilisateur tout
    // recommencer sur un Homey qui en a déjà dix-sept.
    let calls = 0;
    const stage = await mount({
      createDevice: () => {
        calls += 1;
        if (calls > 1) throw new Error('the switch stopped answering');
        return undefined;
      },
    });
    await openSwitch(stage);
    stage.el('nsw-start-add').dispatch('click');
    await settle();

    assert.equal(stage.homey.doneCalls, 0, 'l\'assistant ne se ferme pas sur un échec');
    assert.match(stage.el('nsw-start-status').textContent, /1/);
    const adopted = stage.homey.emitted.find((entry) => entry.event === 'adopted');
    assert.deepEqual(plain((adopted?.data as { ids: string[] }).ids).length, 1,
      'le driver apprend ce qui a RÉELLEMENT été créé');
  });

  test('le driver apprend ce que la vue a créé', async () => {
    const stage = await mount();
    await openSwitch(stage);
    stage.el('nsw-start-add').dispatch('click');
    await settle();
    const adopted = stage.homey.emitted.find((entry) => entry.event === 'adopted');
    assert.ok(adopted, 'sans ce retour, une adoption muette est indiscernable d\'une vue morte');
    assert.equal((adopted.data as { ids: string[] }).ids.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Le balayage et les verdicts
// ---------------------------------------------------------------------------

describe('le balayage', () => {
  test('lancer puis interroger, jamais attendre', async () => {
    const stage = await mount();
    const events = stage.homey.events();
    assert.equal(events[0], 'scan_start');
    assert.ok(events.includes('scan_status'));
  });

  test('tout ce qui parle SNMP est proposé : le tri se fait à l\'ouverture', async () => {
    // Le balayage partagé trie sur « est-ce un onduleur », ce qui n'a aucun rapport
    // avec la question posée ici — et un switch atterrit forcément dans `others`.
    const stage = await mount();
    assert.equal(stage.el('nsw-start-devices').children.length, 2);
  });

  test('🔴 une liste vide dit quoi activer, elle ne dit pas « rien trouvé »', async () => {
    const stage = await mount({
      handlers: handlers({
        scan_status: () => ({ running: false, done: 254, total: 254, subnet: '192.168.1', error: null, devices: [] }),
      }),
    });
    const help = stage.el('nsw-start-help');
    assert.equal(help.className.includes('nsw-start-hidden'), false, 'le panneau d\'aide doit s\'afficher');
    assert.match(help.textContent, /SNMP/);
    assert.match(help.textContent, /nmanaged/, 'un switch non administrable n\'a aucun agent : il faut le dire');
  });

  test('🔴 une erreur de balayage n\'est pas une liste vide', async () => {
    // Dire « activez le SNMP » à quelqu'un dont le balayage n'a pas pu démarrer l'envoie
    // chercher un problème qui n'existe pas.
    const stage = await mount({
      handlers: handlers({
        scan_status: () => ({ running: false, done: 0, total: 0, subnet: null, error: 'the app could not work out which subnet to sweep', devices: [] }),
      }),
    });
    assert.ok(stage.el('nsw-start-status').className.includes('bad'));
    assert.equal(stage.el('nsw-start-help').className.includes('nsw-start-hidden'), true);
  });

  test('une adresse muette mène au panneau d\'aide, pas à une erreur nue', async () => {
    const stage = await mount({
      handlers: handlers({ ports: () => ({ ...PORTS_REPLY, outcome: 'silent', ports: [] }) }),
    });
    await openSwitch(stage);
    assert.equal(stage.el('nsw-start-help').className.includes('nsw-start-hidden'), false);
  });

  test('un appareil sans port physique le dit, plutôt que d\'ouvrir une liste vide', async () => {
    const stage = await mount({
      handlers: handlers({ ports: () => ({ ...PORTS_REPLY, outcome: 'no-ports', ports: [] }) }),
    });
    await openSwitch(stage);
    assert.ok(stage.el('nsw-start-status').className.includes('bad'));
    assert.equal(stage.el('nsw-start-ports-panel').className.includes('nsw-start-hidden'), true);
  });

  test('un appareil qui ne ressemble pas à un switch est ouvert quand même, en le disant', async () => {
    // L'utilisateur a désigné cette adresse : il sait mieux que l'heuristique.
    const stage = await mount({
      handlers: handlers({ ports: () => ({ ...PORTS_REPLY, looksLikeSwitch: false }) }),
    });
    await openSwitch(stage);
    assert.equal(stage.el('nsw-start-ports-panel').className.includes('nsw-start-hidden'), false);
    assert.match(stage.el('nsw-start-ports-hint').textContent, /does not look like a switch/);
  });

  test('la communauté saisie part avec le balayage ET avec l\'ouverture', async () => {
    // Le balayage de l'onduleur écrivait « public » en dur : un utilisateur ayant changé
    // sa communauté voyait son appareil adopté avec la mauvaise, sans un mot.
    const stage = await mount();
    stage.el('nsw-start-community').value = 'secret';
    stage.el('nsw-start-search').dispatch('click');
    await settle();
    await openSwitch(stage);

    const start = stage.homey.emitted.filter((e) => e.event === 'scan_start').pop();
    assert.equal((start?.data as { community: string }).community, 'secret');
    const ports = stage.homey.emitted.filter((e) => e.event === 'ports').pop();
    assert.equal((ports?.data as { community: string }).community, 'secret');
  });

  test('la saisie manuelle d\'adresse ouvre le switch directement', async () => {
    const stage = await mount();
    stage.el('nsw-start-host').value = '10.0.0.5';
    stage.el('nsw-start-open').dispatch('click');
    await settle();

    const ports = stage.homey.emitted.filter((e) => e.event === 'ports').pop();
    assert.equal((ports?.data as { host: string }).host, '10.0.0.5');
    assert.equal(stage.el('nsw-start-ports-panel').className.includes('nsw-start-hidden'), false);
  });

  test('« retour à la liste » ramène au panneau des adresses', async () => {
    const stage = await mount();
    await openSwitch(stage);
    stage.el('nsw-start-back').dispatch('click');
    await settle();
    assert.equal(stage.el('nsw-start-ports-panel').className.includes('nsw-start-hidden'), true);
    assert.equal(stage.el('nsw-start-devices').className.includes('nsw-start-hidden'), false);
  });
});
