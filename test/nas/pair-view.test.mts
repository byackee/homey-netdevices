/**
 * Les vues de pairing du driver NAS, exécutées.
 *
 * 🔴 Pourquoi cette suite existe, et ce qu'elle est seule à voir.
 *
 * Neuf pannes de pairing ont coûté trois apps, et AUCUNE n'était détectable par les
 * garde-fous du projet : `npm test` n'exécute pas de HTML, `homey app validate` ne lit
 * pas le JavaScript des vues, et le SDK type les résultats de pairing `any[]` — donc le
 * compilateur ne voit pas passer la clé en trop qui vide la liste. Aucune de ces neuf
 * pannes n'émettait le moindre message d'erreur.
 *
 * Ce fichier charge les vraies vues dans un DOM minimal et les fait tourner. Chaque
 * `test` porte le numéro de la panne qu'il attrape. Les vues du driver NAS sont écrites
 * sur le modèle de celles de l'onduleur : elles héritent donc des mêmes pièges, et il
 * leur faut le même filet — pas la confiance qu'une copie reste correcte.
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

/** `.testbuild/test/nas` → la racine du dépôt. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PAIR_DIR = path.join(ROOT, 'drivers/nas/pair');

function readView(name: string): { html: string; parsed: ParsedView; code: string } {
  // 🔴 Les vues de réparation vivent sous `repair/`, pas `pair/`. Homey les y cherche,
  // et `homey app validate` ne parcourt que `drivers[].pair[]` : une vue mal rangée
  // valide proprement et ne casse qu'au moment où l'utilisateur appuie sur Maintenance.
  const dir = name === 'repair' ? PAIR_DIR.replace(/pair$/, 'repair') : PAIR_DIR;
  const html = readFileSync(path.join(dir, `${name}.html`), 'utf8');
  const parsed = parseView(html);
  return { html, parsed, code: parsed.scripts.map(stripComments).join('\n') };
}

const START = readView('start');
const REPAIR = readView('repair');

const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, 'drivers/nas/driver.compose.json'), 'utf8'),
) as { pair?: Array<Record<string, unknown>>; repair?: Array<Record<string, unknown>> };

/** Les seules clés qu'un résultat de pairing admet. Toute autre vide la liste. */
const ALLOWED_KEYS = [
  'name', 'data', 'store', 'settings', 'icon', 'capabilities', 'capabilitiesOptions',
];

/**
 * Un hôte tel que le driver le rapporte (`Finding`).
 *
 * `device` est la charge utile assemblée par `drivers/nas/pairing.mts`. Elle est
 * reproduite ici à l'identique parce que ce que ces tests vérifient, c'est que la vue la
 * fait PASSER telle quelle — pas qu'elle sait la reconstruire.
 */
const SYNOLOGY = {
  host: '192.168.1.30',
  name: 'DiskStation',
  description: 'Linux DiskStation 4.4.302+',
  vendor: 'Synology',
  version: 'v2c',
  volumes: 2,
  device: {
    name: 'Synology DiskStation',
    data: { id: 'nas:mac:00-11-32-aa-bb-cc' },
    store: { mac: '00:11:32:AA:BB:CC' },
    settings: { host: '192.168.1.30', community: 'public', version: 'v2c' },
    capabilities: ['nas_cpu_load', 'nas_memory_used', 'nas_uptime', 'nas_storage_used.volume1'],
    capabilitiesOptions: {
      'nas_storage_used.volume1': { title: { en: '/volume1', fr: '/volume1', nl: '/volume1' } },
    },
  },
};

/** Un Linux sans nom publié : il ne reste que la description. */
const NAMELESS = {
  host: '192.168.1.44',
  name: null,
  description: 'Linux srv01 5.15.0-91-generic x86_64',
  vendor: null,
  version: 'v1',
  volumes: 1,
  device: {
    name: 'Linux (192.168.1.44)',
    data: { id: 'nas:host:192.168.1.44' },
    store: { mac: null },
    settings: { host: '192.168.1.44', community: 'public', version: 'v1' },
    capabilities: ['nas_uptime'],
    capabilitiesOptions: {},
  },
};

/** Ça parle SNMP, mais pas HOST-RESOURCES-MIB : donc pas de `device`, pas d'adoption. */
const NOT_A_HOST = {
  host: '192.168.1.50',
  name: 'switch-salon',
  description: 'HP 1820-24G',
  vendor: null,
  version: 'v2c',
  volumes: 0,
};

/** Monte la vue `start` seule, la fait tourner, et rend la scène une fois calmée. */
async function runStart(options: FakeHomeyOptions): Promise<Stage> {
  const stage = new Stage(new FakeHomey(options));
  stage.load(START.html, 'start.html');
  await settle();
  return stage;
}

/** Le balayage le plus courant : il tourne un tour, puis rend son résultat. */
function sweepHandlers(final: Record<string, unknown>): Record<string, (data: unknown) => unknown> {
  let polls = 0;
  return {
    scan_start: () => ({ started: true, subnet: '192.168.1', total: 254 }),
    scan_status: () => {
      polls += 1;
      if (polls === 1) {
        return {
          running: true, done: 40, total: 254, subnet: '192.168.1',
          error: null, found: [], others: [], reachable: [],
        };
      }
      return {
        running: false, done: 254, total: 254, subnet: '192.168.1',
        error: null, found: [], others: [], reachable: [], ...final,
      };
    },
    adopted: () => undefined,
  };
}

// ---------------------------------------------------------------------------

describe('les vues NAS — ce que le HTML ne doit pas contenir', () => {
  test('panne 1 — aucune vue ne charge /homey.js elle-même', () => {
    // Homey injecte déjà son API. Une seconde copie construit une instance qui n'est
    // rattachée à aucune session : le script tourne, le bouton se renomme, et tous les
    // `emit` partent dans le vide. Sans une erreur, sans un log.
    assert.deepEqual(START.parsed.scriptSources, [], 'start.html charge un script externe');
    assert.deepEqual(REPAIR.parsed.scriptSources, [], 'repair.html charge un script externe');
    assert.ok(!START.code.includes('homey.js'));
    assert.ok(!REPAIR.code.includes('homey.js'));
  });

  test('panne 3 — aucune vue n’attend onHomeyReady', () => {
    assert.ok(!START.code.includes('onHomeyReady'), 'start.html attend onHomeyReady');
    assert.ok(!REPAIR.code.includes('onHomeyReady'), 'repair.html attend onHomeyReady');
  });

  test('panne 2 — Homey.ready() est le tout premier appel, et setTitle n’existe pas', async () => {
    // L'ordre du texte ne prouverait rien : `report()` est défini en haut du script et
    // contient un `Homey.emit`, mais il n'est appelé qu'après. C'est l'ordre
    // d'EXÉCUTION qui compte.
    for (const view of [START, REPAIR]) {
      assert.ok(!view.code.includes('setTitle'), 'setTitle() tue le script');
    }

    const start = await runStart({ handlers: sweepHandlers({ found: [] }) });
    assert.equal(start.homey.calls[0], 'ready', start.homey.calls.slice(0, 3).join(' → '));

    const repair = new Stage(new FakeHomey({ handlers: { getConfig: () => null } }));
    repair.load(REPAIR.html, 'repair.html');
    await settle();
    assert.equal(repair.homey.calls[0], 'ready', repair.homey.calls.slice(0, 3).join(' → '));
  });

  test('panne 4 — aucune vue ne pilote la navigation de la session', () => {
    // `session.showView()` depuis un handler bloque : Homey attend le retour du handler,
    // le handler attend la transition.
    assert.ok(!START.code.includes('showView'));
    assert.ok(!REPAIR.code.includes('showView'));
  });

  test('panne 5 — une seule vue custom, qui crée l’appareil elle-même', () => {
    assert.equal(MANIFEST.pair?.length, 1, 'le driver déclare plus d’une vue de pairing');
    assert.equal(MANIFEST.pair?.[0]?.id, 'start');
    assert.ok(!('template' in (MANIFEST.pair?.[0] ?? {})), 'la vue de pairing est un template');
    assert.equal(MANIFEST.repair?.length, 1);
    assert.equal(MANIFEST.repair?.[0]?.id, 'repair');
    assert.ok(START.code.includes('Homey.createDevice'), 'la vue ne crée aucun appareil');
    assert.ok(START.code.includes('Homey.done'));
  });

  test('🔴 panne 7 — chaque identifiant porte le préfixe de SA vue, pas celui du voisin', () => {
    // Toutes les vues d'un driver partagent UN document. Et ces vues-ci sont écrites sur
    // le modèle de celles de l'onduleur : un préfixe recopié tel quel serait exactement
    // l'inattention qui rend la collision possible.
    const ids = (view: ParsedView): string[] => {
      const collected: string[] = [];
      for (const root of view.nodes) {
        for (const element of root.walk()) if (element.id) collected.push(element.id);
      }
      return collected;
    };
    const startIds = ids(START.parsed);
    const repairIds = ids(REPAIR.parsed);

    assert.ok(startIds.length > 5, 'la vue start n’a presque pas d’identifiants — analyse ratée ?');
    assert.ok(repairIds.length > 3);
    for (const id of startIds) assert.ok(id.startsWith('nas-start-'), `identifiant non préfixé : ${id}`);
    for (const id of repairIds) assert.ok(id.startsWith('nas-repair-'), `identifiant non préfixé : ${id}`);

    assert.deepEqual(startIds.filter((id) => repairIds.includes(id)), [],
      'deux vues se disputent les mêmes identifiants');
    for (const id of [...startIds, ...repairIds]) {
      assert.ok(!id.startsWith('ups-'), `préfixe du driver onduleur recopié : ${id}`);
    }
  });

  test('panne 7 — chaque script est enfermé dans son IIFE', () => {
    for (const [name, view] of [['start', START], ['repair', REPAIR]] as const) {
      assert.equal(view.parsed.scripts.length, 1, `${name}: plus d’un script`);
      assert.match(view.code.trim(), /^\(function \(\) \{/, `${name}: le script n’est pas encapsulé`);
      assert.match(view.code.trim(), /\}\)\(\);$/, `${name}: l’IIFE n’est pas fermée`);
    }
  });

  test('panne 9 — la vue interroge, elle n’attend pas d’être poussée', () => {
    assert.ok(!START.code.includes('Homey.on('), 'la vue écoute un push');
    assert.ok(!REPAIR.code.includes('Homey.on('));
    assert.ok(START.code.includes("Homey.emit('scan_start'"));
    assert.ok(START.code.includes("Homey.emit('scan_status'"));
  });
});

// ---------------------------------------------------------------------------

describe('panne 8 — les deux chemins de démarrage', () => {
  // Le bug de course de vtherm ne se manifestait QUE lorsque l'API était déjà prête :
  // jamais en développement, toujours chez l'utilisateur.
  for (const ready of ['sync', 'async', 'throws'] as const) {
    test(`Homey.ready() ${ready} — la vue démarre et balaie`, async () => {
      const stage = await runStart({ ready, handlers: sweepHandlers({ found: [SYNOLOGY] }) });

      assert.match(stage.homey.log(), /view script running/, 'le script n’a jamais démarré');
      assert.match(stage.homey.log(), /view ready, starting sweep/);
      assert.equal(stage.homey.readyCalls, 1);
      assert.ok(!stage.homey.log().includes('window error'), stage.homey.log());
      assert.ok(!stage.homey.log().includes('unhandled rejection'), stage.homey.log());
      assert.equal(stage.el('nas-start-list').children.length, 1, 'la liste est restée vide');
      assert.deepEqual(stage.homey.lostEmits, [],
        `émis avant que la session soit prête : ${stage.homey.lostEmits.join(', ')}`);
    });
  }

  test('la vue ne laisse rien dans la portée globale', async () => {
    // Une vue enfermée dans son IIFE ne publie rien, donc rien ne peut écraser la
    // fonction homonyme de sa voisine.
    const stage = await runStart({ handlers: sweepHandlers({ found: [] }) });
    assert.deepEqual(stage.globalLeaks(), []);
  });
});

// ---------------------------------------------------------------------------

describe('le balayage — lancer, puis interroger', () => {
  test('la vue lance le balayage puis l’interroge, elle ne l’attend jamais', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY] }) });
    const events = stage.homey.events();
    assert.equal(events[0], 'scan_start');
    assert.ok(events.filter((event) => event === 'scan_status').length >= 2,
      `la vue n’a interrogé qu’une fois : ${events.join(' → ')}`);
  });

  test('la communauté saisie part avec le balayage', async () => {
    // Le défaut n°1 de la revue vivait ici : la communauté trouvée par le balayage
    // n'atteignait pas l'appareil adopté.
    const stage = await runStart({ handlers: sweepHandlers({ found: [] }) });
    stage.el('nas-start-community').value = 'privé';
    stage.el('nas-start-search').dispatch('click', {});
    await settle();

    const starts = stage.homey.emitted.filter((entry) => entry.event === 'scan_start');
    assert.deepEqual(plain(starts[starts.length - 1]?.data), { community: 'privé' });
  });

  test('chaque hôte devient une ligne cliquable, nommée et chiffrée', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY, NAMELESS] }) });
    const rows = stage.el('nas-start-list').children;

    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent, /Synology DiskStation/);
    assert.match(rows[0]!.textContent, /192\.168\.1\.30/);
    assert.match(rows[1]!.textContent, /Linux \(192\.168\.1\.44\)/);
  });

  test('une erreur de balayage n’est pas une liste vide', async () => {
    // Dire « activez le SNMP » à quelqu'un dont le balayage n'a pas pu démarrer l'envoie
    // chercher un problème ailleurs.
    const stage = await runStart({
      handlers: sweepHandlers({ error: 'the app could not work out which subnet to sweep' }),
    });
    assert.match(stage.el('nas-start-status').textContent, /could not work out which subnet/);
    assert.ok(stage.el('nas-start-help').className.includes('hidden'),
      'la marche à suivre s’affiche alors qu’on ne sait même pas où balayer');
  });

  test('🔴 rien trouvé ⇒ la marche à suivre, jamais « aucun appareil trouvé »', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [] }) });
    const help = stage.el('nas-start-help');
    assert.ok(!help.className.includes('hidden'), 'aucune explication n’a été montrée');
    assert.match(help.textContent, /Synology/);
    assert.match(help.textContent, /QNAP/);
    assert.match(help.textContent, /snmpd/);
  });

  test('🔴 « le SNMP marche ici, mais pas sur cette machine » est un diagnostic distinct', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [], others: [NOT_A_HOST] }) });
    const help = stage.el('nas-start-help');
    assert.match(help.textContent, /SNMP works here/);
    assert.match(help.textContent, /192\.168\.1\.50/);
  });

  test('🔴 une adresse joignable et muette est nommée, pas oubliée', async () => {
    const stage = await runStart({
      handlers: sweepHandlers({ found: [], reachable: ['192.168.1.60'] }),
    });
    assert.match(stage.el('nas-start-help').textContent, /192\.168\.1\.60/);
  });
});

// ---------------------------------------------------------------------------

describe('l’adoption — la charge utile passe telle quelle', () => {
  test('🔴 panne 6 — la vue passe `device` verbatim, sans y ajouter une clé', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY] }) });
    stage.el('nas-start-list').children[0]!.dispatch('click', {});
    await settle();

    assert.equal(stage.homey.created.length, 1, 'aucun appareil n’a été créé');
    const payload = plain(stage.homey.created[0]!);
    assert.deepEqual(payload, SYNOLOGY.device, 'la vue a reconstruit la charge utile');
    for (const key of Object.keys(payload)) {
      assert.ok(ALLOWED_KEYS.includes(key), `clé interdite ajoutée par la vue : ${key}`);
    }
  });

  test('🔴 les capabilities décidées au pairing arrivent bien à createDevice', async () => {
    // Sans elles, l'appareil naîtrait avec la seule capability du manifeste et
    // n'afficherait rien jusqu'au premier relevé lent — un quart d'heure de tuile vide.
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY] }) });
    stage.el('nas-start-list').children[0]!.dispatch('click', {});
    await settle();

    const payload = plain(stage.homey.created[0]!) as { capabilities?: string[] };
    assert.deepEqual(payload.capabilities, SYNOLOGY.device.capabilities);
  });

  test('l’adoption termine la session et le dit au driver', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY] }) });
    stage.el('nas-start-list').children[0]!.dispatch('click', {});
    await settle();

    assert.equal(stage.homey.doneCalls, 1, 'l’assistant ne s’est pas fermé');
    const adopted = stage.homey.emitted.find((entry) => entry.event === 'adopted');
    assert.deepEqual(plain(adopted?.data), { host: '192.168.1.30', id: 'nas:mac:00-11-32-aa-bb-cc' });
  });

  test('un createDevice qui échoue laisse une trace et rouvre l’adoption', async () => {
    // Une adoption muette est indiscernable d'une vue qui n'a jamais parlé.
    // `createDevice` rend une promesse rejetée, et non une exception synchrone : c'est
    // ce que fait le vrai SDK, et tester l'autre forme testerait un chemin qui n'existe
    // pas en production.
    const stage = await runStart({
      handlers: sweepHandlers({ found: [SYNOLOGY] }),
      createDevice: () => Promise.reject(new Error('Homey a refusé')),
      translations: { 'pair.error': 'Something went wrong: {{message}}' },
    });
    stage.el('nas-start-list').children[0]!.dispatch('click', {});
    await settle();

    assert.equal(stage.homey.doneCalls, 0);
    assert.match(stage.homey.log(), /createDevice failed: Homey a refusé/);
    assert.match(stage.el('nas-start-status').textContent, /Homey a refusé/);
  });
});

// ---------------------------------------------------------------------------

describe('la sonde manuelle — chaque verdict mène ailleurs', () => {
  async function probe(reply: Record<string, unknown>): Promise<Stage> {
    const stage = await runStart({
      handlers: { ...sweepHandlers({ found: [] }), probe: () => reply },
    });
    stage.el('nas-start-host').value = '192.168.1.30';
    stage.el('nas-start-add').dispatch('click', {});
    await settle();
    return stage;
  }

  test('un hôte lisible est adopté sans passer par la liste', async () => {
    const stage = await probe({ ...SYNOLOGY, outcome: 'host' });
    assert.equal(stage.homey.created.length, 1);
    assert.deepEqual(plain(stage.homey.created[0]!), SYNOLOGY.device);
  });

  test('🔴 « parle SNMP » et « ne rend rien de lisible » mènent à la marche à suivre, pas à une erreur', async () => {
    for (const outcome of ['snmp', 'nothing-readable']) {
      const stage = await probe({ ...NOT_A_HOST, outcome });
      assert.ok(!stage.el('nas-start-help').className.includes('hidden'), outcome);
      assert.equal(stage.homey.created.length, 0, `${outcome} a créé un appareil`);
    }
  });

  test('une adresse déjà appairée le dit, plutôt que « n’a pas répondu »', async () => {
    // L'utilisateur cherche une machine qu'il a sous les yeux dans une autre pièce.
    const stage = await probe({ ...NOT_A_HOST, outcome: 'already-paired' });
    assert.match(stage.el('nas-start-status').textContent, /already added/);
  });

  test('une adresse muette envoie vérifier l’adresse, pas la MIB', async () => {
    const stage = await probe({ ...NOT_A_HOST, outcome: 'silent' });
    assert.match(stage.el('nas-start-status').textContent, /did not answer at all/);
  });

  test('🔴 un résultat sans charge utile ne s’adopte pas', async () => {
    // L'offrir créerait un appareil sans une seule capability, donc une tuile vide pour
    // toujours.
    const stage = await runStart({
      handlers: { ...sweepHandlers({ found: [NOT_A_HOST] }), probe: () => null },
    });
    stage.el('nas-start-list').children[0]!.dispatch('click', {});
    await settle();
    assert.equal(stage.homey.created.length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('la réparation', () => {
  async function runRepair(handlers: Record<string, (data: unknown) => unknown>): Promise<Stage> {
    const stage = new Stage(new FakeHomey({ handlers }));
    stage.load(REPAIR.html, 'repair.html');
    await settle();
    return stage;
  }

  test('le formulaire est pré-rempli avec ce que l’appareil porte déjà', async () => {
    // Une réparation se résume presque toujours à corriger le dernier octet.
    const stage = await runRepair({
      getConfig: () => ({ host: '192.168.1.30', community: 'privé' }),
    });
    assert.equal(stage.el('nas-repair-host').value, '192.168.1.30');
    assert.equal(stage.el('nas-repair-community').value, 'privé');
  });

  test('une adresse acceptée termine la session', async () => {
    const stage = await runRepair({
      getConfig: () => ({ host: '192.168.1.30', community: 'public' }),
      setAddress: () => ({ ok: true }),
    });
    stage.el('nas-repair-host').value = '192.168.1.31';
    stage.el('nas-repair-save').dispatch('click', {});
    await settle();
    assert.equal(stage.homey.doneCalls, 1);
  });

  test('🔴 une autre machine à cette adresse ne réécrit rien, et le dit', async () => {
    // Écraser l'adresse ici ferait pointer l'appareil sur le voisin, en silence : il
    // continuerait de relever, simplement plus la bonne machine.
    const stage = await runRepair({
      getConfig: () => ({ host: '192.168.1.30', community: 'public' }),
      setAddress: () => ({ ok: false, found: 'AutreNAS', expected: 'DiskStation' }),
    });
    stage.el('nas-repair-host').value = '192.168.1.31';
    stage.el('nas-repair-save').dispatch('click', {});
    await settle();

    assert.equal(stage.homey.doneCalls, 0, 'la session s’est terminée sur un mauvais appareil');
    const result = stage.el('nas-repair-result').textContent;
    assert.match(result, /AutreNAS/);
    assert.match(result, /DiskStation/);
  });

  test('un getConfig illisible laisse un formulaire vide, pas une vue morte', async () => {
    const stage = await runRepair({
      getConfig: () => { throw new Error('rien à lire'); },
    });
    assert.match(stage.homey.log(), /getConfig failed/);
    assert.match(stage.homey.log(), /view script running/);
    assert.ok(!stage.homey.log().includes('unhandled rejection'), stage.homey.log());
  });
});
