/**
 * La page de réglages, exécutée contre les vrais handlers de l'API de l'app.
 *
 * 🔴 Pourquoi cette suite existe.
 *
 * La 1.0.10 est partie en certification avec une page de réglages dont les trois
 * panneaux lisaient des champs que l'API n'envoie pas :
 *
 *   - le test d'une adresse lisait `result.ok` et `result.reachable` là où
 *     `POST /probe` renvoie `outcome` ;
 *   - le balayage lisait `status.devices` et `status.reachableWithoutSnmp` là où
 *     `GET /scan` renvoie `found` et `others`.
 *
 * Tout valait `undefined`, donc rien ne levait : le test d'adresse annonçait
 * « n'a pas répondu du tout » sur un onduleur qui venait de donner son modèle, et
 * le balayage concluait « aucun appareil SNMP n'a répondu » sur un sous-réseau
 * plein de matériel qui venait de répondre. Le relecteur d'Athom a vu le premier ;
 * `tsc` ne regarde pas cette page, `homey app validate` non plus, et une propriété
 * absente n'est pas une erreur en JavaScript.
 *
 * Le garde statique de `store-review.test.mts` rapproche les noms de champs des
 * deux côtés. Celui-ci va plus loin et exécute : la vraie page, dans un DOM
 * minimal, dont chaque `Homey.api(...)` est routé vers le VRAI handler compilé
 * depuis `api.mts`. Un renommage de champ d'un côté fait tomber ce fichier même
 * si les deux fichiers restent cohérents avec eux-mêmes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import vm from 'node:vm';

import { FakeDocument, FakeWindow, parseView, settle } from './dom.mjs';
import api from '../../api.mjs';

/** `.testbuild/test/views` → la racine du dépôt. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGE = readFileSync(path.join(ROOT, 'settings/index.html'), 'utf8');

/** Ce que l'app expose aux handlers, réduit à ce qu'ils appellent réellement. */
interface FauxApp {
  hasTraceSource(): boolean;
  getTrace(): string[];
  getScanState(): unknown;
  startScan(pris: Set<string>, community: string): Promise<unknown>;
  probeAddress(host: string, community: string): Promise<unknown>;
}

/** Un état de balayage tel que `app.mts` le tient. */
function etatDeBalayage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    running: false,
    subnet: '192.168.1.0/24',
    error: null,
    probed: 254,
    total: 254,
    found: [],
    others: [],
    ...over,
  };
}

/** Une trouvaille telle que le balayage la rapporte (`ScanFinding`). */
function trouvaille(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: '192.168.1.20',
    source: 'synology',
    description: 'Synology DiskStation DS220+',
    name: 'diskstation',
    model: 'DS220+',
    ...over,
  };
}

/** Le résultat d'une interrogation d'adresse (`AddressProbe`). */
function sonde(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: '192.168.1.20',
    outcome: 'ups',
    version: 'v2c',
    source: 'synology',
    description: 'Synology DiskStation DS220+',
    name: 'diskstation',
    identity: { model: 'DS220+', manufacturer: 'Synology', serial: 'ABC123' },
    ...over,
  };
}

/**
 * La page chargée et lancée, avec `Homey.api` branché sur les vrais handlers.
 *
 * 🔴 C'est le seul point qui compte : `api` est le module compilé depuis
 * `api.mts`, pas une imitation. Une réponse inventée à la main referait la faute
 * qu'on cherche à empêcher — c'est très exactement ce que la page faisait déjà,
 * en supposant des champs que personne n'envoyait.
 */
async function lancer(app: Partial<FauxApp>, traductions: Record<string, string> = {}) {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const appels: string[] = [];

  const homey = {
    ready() { /* la page l'appelle en premier ; rien à faire ici */ },
    __(cle: string): string {
      return traductions[cle] ?? cle;
    },
    api(
      methode: string,
      chemin: string,
      corps: Record<string, unknown> | null,
      rappel: (err: unknown, resultat?: unknown) => void,
    ): void {
      appels.push(`${methode} ${chemin}`);
      const requete = {
        homey: { app: app as unknown },
        body: corps ?? {},
        query: {},
        params: {},
      };

      const routes: Record<string, ((requete: never) => Promise<unknown>) | undefined> = {
        'GET /trace': api.getTrace,
        'GET /scan': api.getScan,
        'POST /scan': api.postScan,
        'POST /probe': api.postProbe,
      };
      const handler = routes[`${methode} ${chemin}`];

      if (!handler) {
        // Bruyant volontairement : une route inconnue est une erreur de montage
        // du test, et la page l'avalerait dans son `catch`.
        rappel(new Error(`no handler for ${methode} ${chemin}`));
        return;
      }

      Promise.resolve(handler(requete as never))
        .then((resultat) => rappel(null, resultat))
        .catch((error) => rappel(error));
    },
  };

  const contexte: Record<string, unknown> = {
    document, window, console,
    setTimeout: (rappel: () => void) => setTimeout(rappel, 0),
    clearTimeout,
  };
  vm.createContext(contexte);

  const vue = parseView(PAGE);
  for (const noeud of vue.nodes) document.body.appendChild(noeud);
  for (const script of vue.scripts) vm.runInContext(script, contexte, { filename: 'settings.js' });

  // La page de réglages n'est pas une vue de pairing : Homey lui passe `Homey` en
  // appelant `onHomeyReady`, il n'est jamais global. Une page qui toucherait Homey
  // hors de cette fonction lèverait un ReferenceError que personne ne verrait.
  const demarrer = contexte.onHomeyReady as (h: unknown) => void;
  assert.equal(typeof demarrer, 'function', 'la page n’expose pas onHomeyReady');
  demarrer(homey);
  await settle();

  const el = (id: string) => {
    const element = document.getElementById(id);
    assert.ok(element, `aucun élément « ${id} » dans la page`);
    return element;
  };

  return { document, el, appels };
}

describe('le balayage du réseau', () => {
  test('🔴 il liste ce que GET /scan a trouvé, au lieu de n’afficher personne', async () => {
    // Le défaut : `status.devices` n'existe pas, la liste restait vide quoi qu'il
    // arrive, et la page terminait sur « aucun appareil SNMP n'a répondu ».
    const etat = etatDeBalayage({ found: [trouvaille()] });
    const { el } = await lancer(
      { startScan: async () => etat, getScanState: () => etat },
      { 'settings.scan_found': '{{count}} device(s) answered.', 'settings.scan_none': 'NOTHING ANSWERED' },
    );

    el('scan-run').dispatch('click');
    await settle();

    const rendu = el('scan-result').textContent;
    assert.match(rendu, /192\.168\.1\.20/, 'l’adresse trouvée n’est pas affichée');
    assert.match(rendu, /diskstation/, 'l’appareil trouvé n’est pas nommé');
    assert.doesNotMatch(rendu, /NOTHING ANSWERED/, 'la page annonce « rien » alors qu’elle a trouvé');
  });

  test('🔴 un appareil qui parle SNMP sans être un onduleur est montré, pas tu', async () => {
    // `others` prouve que le SNMP marche sur ce réseau — la différence entre
    // « il n'y a rien » et « c'est l'onduleur qui ne répond pas ».
    const etat = etatDeBalayage({ others: [trouvaille({ host: '192.168.1.30', source: null, name: 'switch-salon' })] });
    const { el } = await lancer(
      { startScan: async () => etat, getScanState: () => etat },
      { 'pair.others_title': 'SNMP works here', 'settings.scan_none': 'NOTHING ANSWERED' },
    );

    el('scan-run').dispatch('click');
    await settle();

    const rendu = el('scan-result').textContent;
    assert.match(rendu, /192\.168\.1\.30/, 'l’appareil SNMP non-onduleur est passé sous silence');
    assert.match(rendu, /SNMP works here/, 'le diagnostic « le SNMP marche ici » n’est pas donné');
    assert.doesNotMatch(rendu, /NOTHING ANSWERED/);
  });

  test('un balayage réellement vide dit qu’il est vide', async () => {
    // L'inverse du garde précédent : sans lui, une page qui n'annonce plus jamais
    // « rien trouvé » passerait les deux tests ci-dessus.
    const etat = etatDeBalayage();
    const { el } = await lancer(
      { startScan: async () => etat, getScanState: () => etat },
      { 'settings.scan_none': 'NOTHING ANSWERED' },
    );

    el('scan-run').dispatch('click');
    await settle();

    assert.match(el('scan-result').textContent, /NOTHING ANSWERED/);
  });

  test('🔴 un balayage qui échoue le dit, au lieu de se faire passer pour vide', async () => {
    // Une erreur laissait la liste vide, et une liste vide était rapportée comme
    // « rien n'a répondu » : la seule lecture qui envoie réparer du matériel sain.
    const etat = etatDeBalayage({ error: 'socket closed by the network' });
    const { el } = await lancer(
      { startScan: async () => etat, getScanState: () => etat },
      { 'settings.scan_none': 'NOTHING ANSWERED' },
    );

    el('scan-run').dispatch('click');
    await settle();

    const rendu = el('scan-result').textContent;
    assert.match(rendu, /socket closed by the network/, 'l’échec du balayage est avalé');
    assert.doesNotMatch(rendu, /NOTHING ANSWERED/, 'un échec est présenté comme un réseau vide');
  });
});

describe('le test d’une seule adresse', () => {
  test('🔴 un onduleur qui répond est annoncé comme ayant répondu', async () => {
    // Le défaut signalé par la certification : `result.ok` n'existant pas, cette
    // réponse-ci tombait dans « n'a pas répondu du tout ».
    const { el } = await lancer(
      { probeAddress: async () => sonde() },
      {
        'settings.probe_ok': '{{host}} answered: {{model}}.',
        'settings.probe_silent': 'DID NOT ANSWER AT ALL',
        'settings.probe_no_snmp': 'REACHABLE BUT SILENT',
      },
    );

    el('probe-host').value = '192.168.1.20';
    el('probe-run').dispatch('click');
    await settle();

    const rendu = el('probe-result').textContent;
    assert.match(rendu, /192\.168\.1\.20 answered/, 'une réponse est présentée comme un silence');
    assert.doesNotMatch(rendu, /DID NOT ANSWER AT ALL/);
  });

  test('🔴 un NAS qui se nomme est nommé, et pas « — »', async () => {
    // `identity` n'est lu que pour les onduleurs : sans repli sur `name`, un NAS
    // ou un switch répondait « a répondu : — » alors qu'il venait de se nommer.
    const { el } = await lancer(
      { probeAddress: async () => sonde({ outcome: 'snmp', identity: null, name: 'diskstation' }) },
      { 'settings.probe_ok': '{{host}} answered: {{model}}.' },
    );

    el('probe-host').value = '192.168.1.20';
    el('probe-run').dispatch('click');
    await settle();

    const rendu = el('probe-result').textContent;
    assert.match(rendu, /answered: diskstation/, 'l’appareil répond mais n’est pas nommé');
    assert.doesNotMatch(rendu, /answered: —/);
  });

  test('🔴 joignable mais muet reste distinct de « rien du tout »', async () => {
    // Les deux appellent des gestes opposés : allumer le SNMP, ou vérifier
    // l'adresse. Les confondre est la panne qui laisse le fil APC du forum ouvert.
    const { el } = await lancer(
      { probeAddress: async () => sonde({ outcome: 'reachable', identity: null, name: null, description: null, source: null, version: null }) },
      {
        'settings.probe_no_snmp': 'REACHABLE BUT SILENT',
        'settings.probe_silent': 'DID NOT ANSWER AT ALL',
      },
    );

    el('probe-host').value = '192.168.1.20';
    el('probe-run').dispatch('click');
    await settle();

    const rendu = el('probe-result').textContent;
    assert.match(rendu, /REACHABLE BUT SILENT/);
    assert.doesNotMatch(rendu, /DID NOT ANSWER AT ALL/);
  });

  test('une adresse vraiment morte est annoncée comme telle', async () => {
    // L'inverse des trois gardes ci-dessus : sans lui, une page qui dirait
    // toujours « a répondu » les passerait tous.
    const { el } = await lancer(
      { probeAddress: async () => sonde({ outcome: 'silent', identity: null, name: null, description: null, source: null, version: null }) },
      { 'settings.probe_silent': 'DID NOT ANSWER AT ALL' },
    );

    el('probe-host').value = '192.168.1.20';
    el('probe-run').dispatch('click');
    await settle();

    assert.match(el('probe-result').textContent, /DID NOT ANSWER AT ALL/);
  });
});

describe('le journal', () => {
  test('« rien d’enregistré » et « rien n’enregistre » restent deux réponses', async () => {
    const eteint = await lancer(
      { hasTraceSource: () => false, getTrace: () => [] },
      { 'settings.trace_off': 'NOTHING IS RECORDING', 'settings.trace_empty': 'NOTHING RECORDED' },
    );
    assert.match(eteint.el('trace-result').textContent, /NOTHING IS RECORDING/);

    const vide = await lancer(
      { hasTraceSource: () => true, getTrace: () => [] },
      { 'settings.trace_off': 'NOTHING IS RECORDING', 'settings.trace_empty': 'NOTHING RECORDED' },
    );
    assert.match(vide.el('trace-result').textContent, /NOTHING RECORDED/);

    const plein = await lancer({ hasTraceSource: () => true, getTrace: () => ['probing 192.168.1.20'] });
    assert.match(plein.el('trace-result').textContent, /probing 192\.168\.1\.20/);
  });
});
