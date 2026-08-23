/**
 * Les vues de pairing, exécutées.
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
 * `test` porte le numéro de la panne qu'il attrape.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import {
  FakeHomey, Stage, parseView, plain, settle, stripComments,
  type FakeHomeyOptions, type ParsedView,
} from './dom.mjs';

/** `.testbuild/test/views` → la racine du dépôt. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PAIR_DIR = path.join(ROOT, 'drivers/ups/pair');

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
  readFileSync(path.join(ROOT, 'drivers/ups/driver.compose.json'), 'utf8'),
) as { pair?: Array<Record<string, unknown>>; repair?: Array<Record<string, unknown>> };

/** Les seules clés qu'un résultat de pairing admet. Toute autre vide la liste. */
const ALLOWED_KEYS = [
  'name', 'data', 'store', 'settings', 'icon', 'capabilities', 'capabilitiesOptions',
];

/**
 * Un onduleur tel que le driver le rapporte (`Finding`).
 *
 * `device` est la charge utile assemblée par `drivers/ups/pairing.mts`. Elle est
 * reproduite ici à l'identique parce que ce que ces tests vérifient, c'est que la vue
 * la fait PASSER telle quelle — pas qu'elle sait la reconstruire.
 */
const SYNOLOGY = {
  host: '192.168.1.30',
  name: 'DiskStation',
  model: 'DS920+',
  manufacturer: 'Synology',
  serial: '2140ABC123456',
  source: 'synology',
  version: 'v2c',
  description: 'Linux DiskStation 4.4.302+',
  vendor: 'Synology',
  device: {
    name: 'Synology DS920+',
    data: { id: 'synology:2140abc123456' },
    store: { source: 'synology', serial: '2140ABC123456', mac: null },
    settings: { host: '192.168.1.30', community: 'public', version: 'v2c' },
  },
};

/** Une carte APC qui ne publie ni nom ni modèle : il ne reste que la description. */
const NAMELESS = {
  host: '192.168.1.44',
  name: null,
  model: null,
  manufacturer: null,
  serial: null,
  source: 'apc',
  version: 'v1',
  description: 'APC Web/SNMP Management Card',
  vendor: 'APC',
  device: {
    name: 'APC UPS',
    data: { id: 'apc:host-192-168-1-44' },
    store: { source: 'apc', serial: null, mac: null },
    settings: { host: '192.168.1.44', community: 'public', version: 'v1' },
  },
};

/** Ça parle SNMP, mais ce n'est pas un onduleur : donc pas de `device`, pas d'adoption. */
const NOT_A_UPS = {
  host: '192.168.1.30',
  name: 'DiskStation',
  model: null,
  manufacturer: null,
  serial: null,
  source: null,
  version: 'v2c',
  description: 'Linux DiskStation 4.4.302+',
  vendor: null,
};

/** Monte la vue `start` seule, la fait tourner, et rend la scène une fois calmée. */
async function runStart(options: FakeHomeyOptions): Promise<Stage> {
  const stage = new Stage(new FakeHomey(options));
  stage.load(START.html, 'start.html');
  await settle();
  return stage;
}

/** Ce que la vue a émis pour un événement donné, la première fois. */
function sent(stage: Stage, event: string): unknown {
  return plain(stage.homey.emitted.find((entry) => entry.event === event)?.data);
}

/** Le balayage le plus courant : il tourne un tour, puis rend son résultat. */
function sweepHandlers(final: Record<string, unknown>): Record<string, (data: unknown) => unknown> {
  let polls = 0;
  return {
    scan_start: () => ({ started: true }),
    scan_status: () => {
      polls += 1;
      if (polls === 1) {
        return { running: true, done: 40, total: 254, error: null, found: [], others: [] };
      }
      return { running: false, done: 254, total: 254, error: null, found: [], others: [], ...final };
    },
  };
}

// ---------------------------------------------------------------------------

describe('les vues de pairing — ce que le HTML ne doit pas contenir', () => {
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
    // C'est la convention des pages de *settings*. En pairing elle n'est jamais
    // appelée : la vue reste blanche, et rien n'est écrit nulle part.
    assert.ok(!START.code.includes('onHomeyReady'), 'start.html attend onHomeyReady');
    assert.ok(!REPAIR.code.includes('onHomeyReady'), 'repair.html attend onHomeyReady');
  });

  test('panne 2 — Homey.ready() est le tout premier appel, et setTitle n’existe pas', async () => {
    // L'ordre du texte ne prouverait rien : `report()` est défini en haut du script et
    // contient un `Homey.emit`, mais il n'est appelé qu'après. C'est l'ordre
    // d'EXÉCUTION qui compte, et c'est un appel trop tôt — `setTitle()` en tête — qui
    // tuait le script avant sa première ligne utile.
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
    // `session.showView()` depuis le handler `showView` bloque : Homey attend le
    // retour du handler, le handler attend la transition.
    assert.ok(!START.code.includes('showView'));
    assert.ok(!REPAIR.code.includes('showView'));
  });

  test('panne 5 — une seule vue custom, qui crée l’appareil elle-même', () => {
    // Une vue custom ne peut pas rejoindre un template système : écran blanc, ou
    // assistant qui se ferme sans avoir rien créé.
    assert.equal(MANIFEST.pair?.length, 1, 'le driver déclare plus d’une vue de pairing');
    assert.equal(MANIFEST.pair?.[0]?.id, 'start');
    assert.ok(!('template' in (MANIFEST.pair?.[0] ?? {})), 'la vue de pairing est un template');
    assert.equal(MANIFEST.repair?.length, 1);
    assert.equal(MANIFEST.repair?.[0]?.id, 'repair');
    assert.ok(START.code.includes('Homey.createDevice'), 'la vue ne crée aucun appareil');
    assert.ok(START.code.includes('Homey.done'));
  });

  test('panne 7 — chaque identifiant porte le préfixe de sa vue', () => {
    // Toutes les vues d'un driver partagent UN document. Sans préfixe,
    // `getElementById('list')` rend celui de la première vue chargée.
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
    for (const id of startIds) assert.ok(id.startsWith('ups-start-'), `identifiant non préfixé : ${id}`);
    for (const id of repairIds) assert.ok(id.startsWith('ups-repair-'), `identifiant non préfixé : ${id}`);

    const shared = startIds.filter((id) => repairIds.includes(id));
    assert.deepEqual(shared, [], 'deux vues se disputent les mêmes identifiants');
  });

  test('panne 7 — chaque script est enfermé dans son IIFE', () => {
    for (const [name, view] of [['start', START], ['repair', REPAIR]] as const) {
      assert.equal(view.parsed.scripts.length, 1, `${name}: plus d’un script`);
      assert.match(view.code.trim(), /^\(function \(\) \{/, `${name}: le script n’est pas encapsulé`);
      assert.match(view.code.trim(), /\}\)\(\);$/, `${name}: l’IIFE n’est pas fermée`);
    }
  });

  test('panne 9 — la vue interroge, elle n’attend pas d’être poussée', () => {
    // `session.emit()` en push rend indiscernables un balayage tombé et un événement
    // jamais arrivé. Tout passe par `Homey.emit()`, en requête/réponse.
    assert.ok(!START.code.includes('Homey.on('), 'la vue écoute un push');
    assert.ok(!REPAIR.code.includes('Homey.on('));
    assert.ok(START.code.includes("Homey.emit('scan_start'"));
    assert.ok(START.code.includes("Homey.emit('scan_status'"));
  });
});

// ---------------------------------------------------------------------------

describe('panne 8 — les deux chemins de démarrage', () => {
  // Le bug de course de vtherm ne se manifestait QUE lorsque l'API était déjà prête :
  // jamais en développement, toujours chez l'utilisateur. Les deux chemins comptent.
  for (const ready of ['sync', 'async', 'throws'] as const) {
    test(`Homey.ready() ${ready} — la vue démarre et balaie`, async () => {
      const stage = await runStart({ ready, handlers: sweepHandlers({ found: [SYNOLOGY] }) });

      assert.match(stage.homey.log(), /view script running/, 'le script n’a jamais démarré');
      assert.match(stage.homey.log(), /view ready, starting sweep/);
      assert.equal(stage.homey.readyCalls, 1);
      assert.ok(!stage.homey.log().includes('window error'), stage.homey.log());
      assert.ok(!stage.homey.log().includes('unhandled rejection'), stage.homey.log());
      assert.equal(stage.el('ups-start-list').children.length, 1, 'la liste est restée vide');
      // Rien n'a été dit avant que la session écoute : c'est la panne n°8 elle-même.
      assert.deepEqual(stage.homey.lostEmits, [],
        `émis avant que la session soit prête : ${stage.homey.lostEmits.join(', ')}`);
    });
  }

  test('la vue ne laisse rien dans la portée globale', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [] }) });
    assert.deepEqual(stage.globalLeaks(), []);
  });
});

// ---------------------------------------------------------------------------

describe('le balayage — lancer, puis interroger', () => {
  test('les dix secondes de l’API : scan_start d’abord, scan_status ensuite', async () => {
    // Un appel d'API est coupé à 10 s, un balayage /24 en prend ~16. Un unique appel
    // qui rendrait la liste finie ne peut pas exister.
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY] }) });
    const events = stage.homey.events();

    assert.equal(events[0], 'scan_start');
    assert.ok(events.slice(1).every((name) => name === 'scan_status'), events.join(','));
    assert.ok(events.filter((name) => name === 'scan_status').length >= 2, 'la vue n’a pas interrogé');
    assert.equal(events.filter((name) => name === 'scan_start').length, 1, 'deux balayages lancés');
  });

  test('la communauté saisie est celle avec laquelle on balaie', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [] }) });
    assert.deepEqual(sent(stage, 'scan_start'), { community: 'public' });
    assert.equal(stage.homey.events().filter((name) => name === 'scan_start').length, 1);
  });

  test('l’avancement bouge pendant que le balayage tourne', async () => {
    // Un écran figé seize secondes se lit comme cassé.
    const seen: string[] = [];
    const stage = new Stage(new FakeHomey({
      handlers: {
        scan_start: () => ({ started: true }),
        scan_status: () => {
          seen.push(stage.el('ups-start-status').textContent);
          return seen.length < 3
            ? { running: true, done: seen.length * 80, total: 254, found: [], others: [] }
            : { running: false, done: 254, total: 254, found: [SYNOLOGY], others: [] };
        },
      },
      translations: { 'pair.scanning_progress': 'Searching — {{done}} of {{total}} addresses checked.' },
    }));
    stage.load(START.html, 'start.html');
    await settle();

    assert.match(seen[1] ?? '', /80 of 254/, `avancement absent : ${JSON.stringify(seen)}`);
    assert.match(seen[2] ?? '', /160 of 254/);
    assert.equal(stage.el('ups-start-progress').className, 'ups-start-bar ups-start-hidden',
      'la barre tourne encore après la fin');
  });

  test('la liste montre le nom que l’appareil se donne, et son adresse', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY, NAMELESS] }) });
    const rows = stage.el('ups-start-list').children;

    assert.equal(rows.length, 2);
    // Le titre est celui que le driver a composé, pas un second calcul dans la vue.
    assert.match(rows[0]!.textContent, /Synology DS920\+/);
    assert.match(rows[0]!.textContent, /192\.168\.1\.30/);
    assert.match(rows[0]!.textContent, /2140ABC123456/);
    assert.match(rows[1]!.textContent, /APC UPS/);
    assert.match(rows[1]!.textContent, /192\.168\.1\.44/);
  });

  test('un balayage refusé le dit, et ne fait pas semblant de chercher', async () => {
    const stage = await runStart({
      handlers: { scan_start: () => ({ started: false, reason: 'no local address' }) },
      translations: { 'pair.error': 'Something went wrong: {{message}}' },
    });

    assert.match(stage.el('ups-start-status').textContent, /no local address/);
    assert.ok(stage.el('ups-start-status').className.includes('bad'));
    assert.deepEqual(stage.homey.events(), ['scan_start'], 'la vue a interrogé un balayage mort');
  });

  test('une erreur de balayage n’est pas une liste vide', async () => {
    // Dire « activez le SNMP » à quelqu'un dont le balayage n'a pas pu démarrer
    // l'envoie chercher au mauvais endroit.
    const stage = await runStart({
      handlers: sweepHandlers({ error: 'sweep failed: EPERM' }),
      translations: { 'pair.error': 'Something went wrong: {{message}}' },
    });

    assert.match(stage.el('ups-start-status').textContent, /EPERM/);
    assert.ok(stage.el('ups-start-help').className.includes('ups-start-hidden'),
      'la marche à suivre s’affiche alors que le balayage a échoué');
  });

  test('une interrogation qui échoue est dite, et tracée', async () => {
    const stage = await runStart({
      handlers: {
        scan_start: () => ({ started: true }),
        scan_status: () => { throw new Error('driver went away'); },
      },
      translations: { 'pair.error': 'Something went wrong: {{message}}' },
    });

    assert.match(stage.el('ups-start-status').textContent, /driver went away/);
    assert.match(stage.homey.log(), /sweep failed: driver went away/);
    assert.ok(!stage.el('ups-start-search').disabled, 'le bouton est resté grisé');
  });
});

// ---------------------------------------------------------------------------

describe('panne 6 — la charge utile passée à createDevice', () => {
  test('elle ne porte QUE les clés admises', async () => {
    // Une seule clé en trop — `class`, `host`, `source` — et la liste se vide sans un
    // mot. Le SDK type ça `any` : le compilateur ne voit rien. Ce test est le filet.
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY] }) });
    stage.el('ups-start-list').children[0]!.dispatch('click');
    await settle();

    assert.equal(stage.homey.created.length, 1, 'aucun appareil créé');
    const payload = stage.homey.created[0]!;
    for (const key of Object.keys(payload)) {
      assert.ok(ALLOWED_KEYS.includes(key), `clé interdite dans le résultat de pairing : ${key}`);
    }
    // Telle quelle : la vue ne rajoute rien au passage, et n'en retire rien non plus.
    assert.deepEqual(plain(payload), SYNOLOGY.device);
  });

  test('l’identité tient au numéro de série, jamais à l’adresse', async () => {
    // Une adresse DHCP bouge ; un appareil apparié dessus reviendrait en doublon.
    const stage = await runStart({ handlers: sweepHandlers({ found: [SYNOLOGY] }) });
    stage.el('ups-start-list').children[0]!.dispatch('click');
    await settle();

    const payload = plain(stage.homey.created[0]!);
    assert.deepEqual(payload.data, { id: 'synology:2140abc123456' },
      'l’identité ne vient pas du driver');
    assert.ok(!JSON.stringify(payload.data).includes('192.168.1.30'),
      'l’identité est bâtie sur l’adresse : un bail DHCP condamnerait l’appareil');
    assert.equal(stage.homey.doneCalls, 1, 'l’assistant ne s’est pas terminé');

    // Le driver doit savoir ce qui a réellement été créé : une adoption muette est
    // indiscernable d’une vue qui n’a jamais parlé.
    assert.deepEqual(sent(stage, 'adopted'),
      { host: '192.168.1.30', id: 'synology:2140abc123456' });
  });

  test('la charge utile du driver passe intacte, quelle qu’elle soit', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [NAMELESS] }) });
    stage.el('ups-start-list').children[0]!.dispatch('click');
    await settle();

    assert.deepEqual(plain(stage.homey.created[0]!), NAMELESS.device);
  });

  test('un candidat sans charge utile ne s’adopte pas', async () => {
    // `device` n'est présent que sur un onduleur. Créer un appareil sur autre chose
    // donnerait un device qui ne relèvera jamais rien, et personne ne saurait pourquoi.
    const stage = await runStart({
      handlers: sweepHandlers({ found: [NOT_A_UPS] }),
      translations: { 'pair.error': 'Something went wrong: {{message}}' },
    });
    stage.el('ups-start-list').children[0]!.dispatch('click');
    await settle();

    assert.equal(stage.homey.created.length, 0, 'un non-onduleur a été adopté');
    assert.match(stage.el('ups-start-status').textContent, /not as a UPS/);
  });

  test('la communauté saisie est celle avec laquelle on sonde', async () => {
    const stage = await runStart({
      handlers: { ...sweepHandlers({ found: [] }), probe: () => ({ ...SYNOLOGY, outcome: 'ups' }) },
    });
    stage.el('ups-start-community').value = 'monitoring';
    stage.el('ups-start-host').value = '192.168.1.30';
    stage.el('ups-start-add').dispatch('click');
    await settle();

    assert.deepEqual(sent(stage, 'probe'), { host: '192.168.1.30', community: 'monitoring' });
  });

  test('une création qui échoue le dit, et laisse réessayer', async () => {
    const stage = await runStart({
      handlers: sweepHandlers({ found: [SYNOLOGY] }),
      createDevice: () => Promise.reject(new Error('device already added')),
      translations: { 'pair.error': 'Something went wrong: {{message}}' },
    });
    stage.el('ups-start-list').children[0]!.dispatch('click');
    await settle();

    assert.match(stage.el('ups-start-status').textContent, /device already added/);
    assert.equal(stage.homey.doneCalls, 0, 'l’assistant s’est fermé sur un échec');

    stage.el('ups-start-list').children[0]!.dispatch('click');
    await settle();
    assert.equal(stage.homey.created.length, 2, 'un second essai est impossible');
  });
});

// ---------------------------------------------------------------------------

describe('rien trouvé — ce qu’il faut aller activer', () => {
  test('la vue ne dit pas « aucun appareil trouvé »', async () => {
    // 🔴 C'est exactement le message qui laisse le fil APC du forum Homey en échec
    // depuis 2018 : il décrit la mauvaise chose. Il n'y a pas « rien », il y a
    // « rien d'activé ».
    const stage = await runStart({ handlers: sweepHandlers({ found: [] }) });
    const text = stage.el('ups-start-help').textContent + stage.el('ups-start-status').textContent;

    assert.ok(!/no (new )?(devices?|ups) found/i.test(text), `message inutile : ${text}`);
    assert.ok(!stage.el('ups-start-help').className.includes('hidden'), 'aucune marche à suivre');
  });

  test('elle nomme les deux choses à activer, avec leur chemin', async () => {
    const stage = await runStart({ handlers: sweepHandlers({ found: [] }) });
    const text = stage.el('ups-start-help').textContent;

    assert.match(text, /Control Panel/, 'le chemin DSM manque');
    assert.match(text, /Terminal & SNMP/);
    assert.match(text, /Hardware & Power/);
    assert.match(text, /APC NMC/, 'le cas de la carte réseau manque');
    assert.match(text, /switched off/);
    assert.match(text, /public/);
  });

  test('« le SNMP marche ici, mais pas sur l’onduleur » n’est pas « rien n’a répondu »', async () => {
    // Trois appareils qui parlent SNMP sans être des onduleurs, c'est un diagnostic
    // beaucoup plus étroit : inutile d'envoyer l'utilisateur activer le SNMP.
    const stage = await runStart({
      handlers: sweepHandlers({ found: [], others: [NOT_A_UPS] }),
    });
    const text = stage.el('ups-start-help').textContent;

    assert.match(text, /SNMP works here/);
    assert.match(text, /192\.168\.1\.30/, 'l’adresse qui répond n’est pas nommée');
    assert.match(text, /DiskStation/);
  });

  test('joignable en ICMP et muet en SNMP est dit comme tel', async () => {
    const stage = await runStart({
      handlers: sweepHandlers({ found: [], reachable: ['192.168.1.7'] }),
    });
    const text = stage.el('ups-start-help').textContent;

    assert.match(text, /Reachable, but silent over SNMP/);
    assert.match(text, /192\.168\.1\.7/);
  });

  test('les traductions remplacent bien le texte anglais du document', async () => {
    const stage = await runStart({
      handlers: sweepHandlers({ found: [] }),
      translations: {
        'pair.title': 'Trouver votre onduleur',
        'pair.empty_title': 'Rien n’a répondu en SNMP — voici ce qu’il faut activer',
      },
    });

    assert.equal(stage.el('ups-start-title').textContent, 'Trouver votre onduleur');
    assert.match(stage.el('ups-start-help').textContent, /voici ce qu’il faut activer/);
  });
});

// ---------------------------------------------------------------------------

describe('l’ajout manuel — la sortie de secours du balayage', () => {
  async function probing(probe: Record<string, unknown>): Promise<Stage> {
    const stage = await runStart({
      handlers: { ...sweepHandlers({ found: [] }), probe: () => probe },
      translations: { 'pair.error': 'Something went wrong: {{message}}' },
    });
    stage.el('ups-start-host').value = '192.168.1.99';
    stage.el('ups-start-add').dispatch('click');
    await settle();
    return stage;
  }

  test('un onduleur est adopté directement', async () => {
    const stage = await probing({ ...SYNOLOGY, outcome: 'ups' });

    assert.equal(stage.homey.created.length, 1);
    assert.deepEqual(plain(stage.homey.created[0]!), SYNOLOGY.device);
    assert.equal(stage.homey.doneCalls, 1);
  });

  test('une adresse déjà appairée est nommée comme telle', async () => {
    // « n'a pas répondu » enverrait chercher une panne réseau pour un appareil que
    // l'utilisateur a déjà sous les yeux dans une autre pièce de Homey.
    const stage = await probing({ ...NOT_A_UPS, host: '192.168.1.99', outcome: 'already-paired' });

    assert.match(stage.el('ups-start-status').textContent, /already added/);
    assert.equal(stage.homey.created.length, 0);
  });

  test('une adresse vide n’interroge personne', async () => {
    const stage = await runStart({ handlers: { ...sweepHandlers({ found: [] }), probe: () => ({}) } });
    stage.el('ups-start-add').dispatch('click');
    await settle();

    assert.ok(!stage.homey.events().includes('probe'));
  });

  test('joignable mais muette : on donne la marche à suivre, pas un échec', async () => {
    const stage = await probing({ ...NOT_A_UPS, host: '192.168.1.99', outcome: 'reachable' });

    assert.match(stage.el('ups-start-help').textContent, /Reachable, but silent over SNMP/);
    assert.match(stage.el('ups-start-help').textContent, /192\.168\.1\.99/);
    assert.equal(stage.homey.created.length, 0);
  });

  test('ça parle SNMP sans être un onduleur : on le nomme', async () => {
    const stage = await probing({
      ...NOT_A_UPS, host: '192.168.1.99', outcome: 'snmp', name: 'office-switch',
      description: 'HP ProCurve',
    });

    assert.match(stage.el('ups-start-help').textContent, /SNMP works here/);
    assert.match(stage.el('ups-start-help').textContent, /office-switch/);
  });

  test('rien du tout : on le dit, sans noyer sous la marche à suivre', async () => {
    const stage = await probing({ ...NOT_A_UPS, host: '192.168.1.99', outcome: 'silent' });

    assert.match(stage.el('ups-start-status').textContent, /192\.168\.1\.99/);
    assert.ok(stage.el('ups-start-status').className.includes('bad'));
    assert.ok(stage.el('ups-start-help').className.includes('hidden'));
  });

  test('la touche Entrée vaut le bouton', async () => {
    const stage = await runStart({
      handlers: {
        ...sweepHandlers({ found: [] }),
        probe: () => ({ ...SYNOLOGY, outcome: 'ups' }),
      },
    });
    stage.el('ups-start-host').value = '192.168.1.99';
    stage.el('ups-start-host').dispatch('keydown', { key: 'Enter' });
    await settle();

    assert.equal(stage.homey.created.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('panne 7 — deux vues, un seul document et une seule portée globale', () => {
  test('la vue de réparation ne touche pas la liste de la vue de pairing', async () => {
    // C'est la panne exacte de vtherm : une page recevait bien ses données et
    // remplissait tranquillement la liste de sa voisine cachée. Ici, les deux vues
    // sont chargées dans le MÊME document et la MÊME portée, comme Homey le fait.
    const homey = new FakeHomey({
      handlers: {
        ...sweepHandlers({ found: [SYNOLOGY] }),
        getConfig: () => ({ host: '10.0.0.5', community: 'monitoring' }),
      },
    });
    const stage = new Stage(homey);
    stage.load(START.html, 'start.html');
    stage.load(REPAIR.html, 'repair.html');
    await settle();

    // Chaque vue a parlé, et chacune a trouvé SES éléments.
    assert.match(homey.log(), /\[pair\/start\] view script running/);
    assert.match(homey.log(), /\[pair\/repair\] view script running/);
    assert.equal(stage.el('ups-start-list').children.length, 1, 'la liste de pairing est vide');
    assert.match(stage.el('ups-start-list').textContent, /Synology DS920\+/);
    assert.equal(stage.el('ups-repair-host').value, '10.0.0.5', 'la réparation n’a rien pré-rempli');
    assert.equal(stage.el('ups-start-host').value, '', 'la réparation a écrit dans le champ voisin');
  });

  test('ni l’une ni l’autre ne publie quoi que ce soit dans la portée globale', async () => {
    // Deux `escapeHtml`, deux `report`, deux `boot` : sans IIFE, la seconde vue
    // chargée écrase les fonctions de la première, en silence.
    const stage = new Stage(new FakeHomey({
      handlers: { ...sweepHandlers({ found: [] }), getConfig: () => null },
    }));
    stage.load(START.html, 'start.html');
    stage.load(REPAIR.html, 'repair.html');
    await settle();

    assert.deepEqual(stage.globalLeaks(), []);
  });
});

// ---------------------------------------------------------------------------

describe('la vue de réparation', () => {
  async function runRepair(options: FakeHomeyOptions): Promise<Stage> {
    const stage = new Stage(new FakeHomey(options));
    stage.load(REPAIR.html, 'repair.html');
    await settle();
    return stage;
  }

  test('elle pré-remplit l’adresse que l’appareil porte déjà', async () => {
    const stage = await runRepair({ handlers: { getConfig: () => ({ host: '10.0.0.5', community: 'monitoring' }) } });

    assert.equal(stage.el('ups-repair-host').value, '10.0.0.5');
    assert.equal(stage.el('ups-repair-community').value, 'monitoring');
  });

  test('sans configuration lisible, un formulaire vide est la bonne réponse', async () => {
    const stage = await runRepair({ handlers: { getConfig: () => { throw new Error('no device'); } } });

    assert.equal(stage.el('ups-repair-host').value, '');
    assert.match(stage.homey.log(), /getConfig failed: no device/);
  });

  test('une adresse acceptée termine l’assistant', async () => {
    const stage = await runRepair({
      handlers: { getConfig: () => ({ host: '10.0.0.5' }), setAddress: () => ({ ok: true }) },
      translations: { 'pair.repair_ok': 'Address updated.' },
    });
    stage.el('ups-repair-host').value = '10.0.0.9';
    stage.el('ups-repair-save').dispatch('click');
    await settle();

    assert.deepEqual(sent(stage, 'setAddress'), { host: '10.0.0.9', community: 'public' });
    assert.match(stage.el('ups-repair-result').textContent, /Address updated/);
    assert.equal(stage.homey.doneCalls, 1);
  });

  test('un autre onduleur à cette adresse n’écrase rien', async () => {
    // Écraser ici ferait pointer l'appareil sur son voisin, sans un mot — et les
    // Flows d'arrêt propre suivraient le mauvais onduleur.
    const stage = await runRepair({
      handlers: {
        getConfig: () => ({ host: '10.0.0.5' }),
        setAddress: () => ({ ok: false, found: 'SRT3000', expected: 'SMT1500' }),
      },
      translations: {
        'pair.repair_mismatch':
          'That address answers, but it is a different UPS ({{found}} instead of {{expected}}). Nothing was changed.',
      },
    });
    stage.el('ups-repair-host').value = '10.0.0.9';
    stage.el('ups-repair-save').dispatch('click');
    await settle();

    assert.match(stage.el('ups-repair-result').textContent, /SRT3000 instead of SMT1500/);
    assert.match(stage.el('ups-repair-result').textContent, /Nothing was changed/);
    assert.equal(stage.homey.doneCalls, 0, 'l’assistant s’est fermé sur un refus');
  });

  test('une adresse vide n’écrit rien', async () => {
    const stage = await runRepair({ handlers: { getConfig: () => null, setAddress: () => ({ ok: true }) } });
    stage.el('ups-repair-save').dispatch('click');
    await settle();

    assert.ok(!stage.homey.events().includes('setAddress'));
  });
});
