/**
 * Un DOM minimal, et de quoi exécuter dedans le JavaScript d'une vue de pairing.
 *
 * 🔴 Pourquoi ce fichier existe. `npm test` n'exécute aucun HTML, `homey app validate`
 * ne lit pas le JavaScript des vues, et le SDK type les résultats de pairing `any[]` :
 * les neuf pannes de pairing du rétro sont donc, littéralement, invisibles pour les
 * deux garde-fous du projet. vtherm a fini par exécuter le script des vues dans un DOM
 * minimal — c'est le seul filet qui attrape « le script est mort à sa deuxième ligne »,
 * « la vue attendait un `onHomeyReady` qui ne vient jamais » et « une vue a rempli la
 * liste de sa voisine ».
 *
 * Deux partis pris :
 *
 * 1. Aucune dépendance. Pas de jsdom : `package.json` appartient à une autre lane, et
 *    surtout un DOM complet cacherait ce qu'on teste sous des milliers de lignes. Ce
 *    DOM-ci ne connaît que ce que les vues utilisent réellement, et toute utilisation
 *    d'autre chose casse bruyamment au lieu de passer inaperçue.
 * 2. `node:vm`, et non `new Function`. C'est ce qui permet de charger DEUX vues dans
 *    UN document ET UNE portée globale — exactement ce que fait Homey, et exactement la
 *    condition de la panne n°7. Un `new Function` donnerait à chaque script sa propre
 *    portée et rendrait la collision intestable.
 */

import vm from 'node:vm';

/** Balises sans fermeture, parmi celles que les vues emploient. */
const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source']);

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (match) => ENTITIES[match] ?? match);
}

type Node = string | FakeElement;

export type Listener = (event: Record<string, unknown>) => void;

/**
 * Un élément. Il expose la poignée de propriétés que les vues touchent, et rien de
 * plus — un appel à quelque chose d'absent lève, ce qui est le comportement voulu.
 */
export class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  private nodes: Node[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  /** Propriétés DOM que les vues affectent directement. */
  type = '';
  value = '';
  placeholder = '';
  disabled = false;
  readonly style: Record<string, string> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }

  set className(value: string) {
    this.attributes.set('class', value);
  }

  get children(): FakeElement[] {
    return this.nodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  get textContent(): string {
    return this.nodes
      .map((node) => (typeof node === 'string' ? node : node.textContent))
      .join('');
  }

  set textContent(value: string) {
    this.nodes = [String(value)];
  }

  /** Sérialisation suffisante pour une assertion ; ce n'est pas un moteur de rendu. */
  get innerHTML(): string {
    return this.nodes
      .map((node) => (typeof node === 'string' ? node : node.outerHTML))
      .join('');
  }

  set innerHTML(html: string) {
    this.replaceChildren(parseNodes(String(html)));
  }

  get outerHTML(): string {
    const attrs = [...this.attributes]
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('');
    if (VOID_TAGS.has(this.tagName)) return `<${this.tagName}${attrs}>`;
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`;
  }

  appendChild(child: FakeElement): FakeElement {
    this.nodes.push(child);
    return child;
  }

  /** Ajoute du texte à la suite, sans toucher aux enfants déjà présents. */
  appendText(text: string): void {
    this.nodes.push(text);
  }

  /** Les nœuds tels quels, texte compris — ce que `innerHTML = …` doit rendre. */
  get childNodes(): ReadonlyArray<string | FakeElement> {
    return this.nodes;
  }

  /** Remplace tout le contenu par ces nœuds. */
  replaceChildren(nodes: ReadonlyArray<string | FakeElement>): void {
    this.nodes = [...nodes];
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(listener);
    else this.listeners.set(type, [listener]);
  }

  /** Déclenche les écouteurs posés par la vue. Pas de bouillonnement : inutile ici. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Combien d'écouteurs de ce type — pour vérifier qu'une vue en pose bien un. */
  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }

  /** Parcours en profondeur, l'élément lui-même inclus. */
  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
}

/** Le document, partagé par toutes les vues d'un même driver — comme chez Homey. */
export class FakeDocument {
  readonly body = new FakeElement('body');

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    for (const element of this.body.walk()) {
      if (element.id === id) return element;
    }
    return null;
  }

  /** Tous les identifiants présents, dans l'ordre du document. */
  ids(): string[] {
    const found: string[] = [];
    for (const element of this.body.walk()) {
      if (element.id) found.push(element.id);
    }
    return found;
  }
}

/** `window`, réduit aux deux écouteurs que les vues posent pour se signaler. */
export class FakeWindow {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(listener);
    else this.listeners.set(type, [listener]);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

// --- Analyse du HTML -------------------------------------------------------

/** Ce qu'un fichier de vue contient, une fois séparé. */
export interface ParsedView {
  /** Les éléments de la vue, `<style>` et `<script>` retirés. */
  nodes: FakeElement[];
  /** Le corps de chaque `<script>`, dans l'ordre. */
  scripts: string[];
  /** Les `src` de chaque `<script src=…>` — doit rester vide dans une vue de pairing. */
  scriptSources: string[];
}

/**
 * Un analyseur volontairement étroit : il couvre le sous-ensemble de HTML que ces vues
 * emploient. Une balise mal formée ou inattendue donne un arbre visiblement faux, et
 * les tests qui cherchent des identifiants précis le signalent aussitôt.
 */
export function parseView(html: string): ParsedView {
  return parseInto(html).view;
}

/**
 * L'analyse elle-même, qui rend aussi le conteneur.
 *
 * Tout atterrit dans un fragment détaché plutôt que dans une liste de racines : sans
 * lui, un nœud de TEXTE au premier niveau n'aurait aucun parent où se poser et serait
 * silencieusement perdu — ce qui suffit à faire disparaître la moitié d'un
 * `innerHTML = '<span…></span>' + texte`.
 */
function parseInto(html: string): { view: ParsedView; fragment: FakeElement } {
  const scripts: string[] = [];
  const scriptSources: string[] = [];
  const fragment = new FakeElement('#fragment');
  const stack: FakeElement[] = [fragment];
  const top = (): FakeElement => stack[stack.length - 1] as FakeElement;

  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) {
      appendText(top(), html.slice(index));
      break;
    }
    if (open > index) appendText(top(), html.slice(index, open));

    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open);
      index = close < 0 ? html.length : close + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, open);
    const raw = html.slice(open + 1, tagEnd);

    if (/^style\b/i.test(raw)) {
      const close = html.toLowerCase().indexOf('</style>', tagEnd);
      index = close < 0 ? html.length : close + '</style>'.length;
      continue;
    }

    if (/^script\b/i.test(raw)) {
      const src = parseAttributes(raw).get('src');
      if (src) scriptSources.push(src);
      const close = html.toLowerCase().indexOf('</script>', tagEnd);
      scripts.push(html.slice(tagEnd + 1, close < 0 ? html.length : close));
      index = close < 0 ? html.length : close + '</script>'.length;
      continue;
    }

    if (raw.startsWith('/')) {
      // Ne jamais dépiler le fragment : un `</div>` en trop ne doit pas faire
      // atterrir la suite du document nulle part.
      if (stack.length > 1) stack.pop();
      index = tagEnd + 1;
      continue;
    }

    const name = /^([a-zA-Z][\w-]*)/.exec(raw)?.[1] ?? '';
    const element = new FakeElement(name);
    for (const [key, value] of parseAttributes(raw)) element.attributes.set(key, value);
    element.type = element.attributes.get('type') ?? '';
    element.value = element.attributes.get('value') ?? '';
    element.placeholder = element.attributes.get('placeholder') ?? '';
    element.disabled = element.attributes.has('disabled');
    top().appendChild(element);
    if (!VOID_TAGS.has(element.tagName) && !raw.endsWith('/')) stack.push(element);
    index = tagEnd + 1;
  }

  return { view: { nodes: fragment.children, scripts, scriptSources }, fragment };
}

/**
 * Le texte des vues est court et sur une seule ligne ; les blancs sont normalisés pour
 * qu'une assertion ne dépende pas de l'indentation du fichier. Le texte purement
 * décoratif entre deux balises est écarté.
 */
function appendText(parent: FakeElement, text: string): void {
  if (!text.trim()) return;
  parent.appendText(decodeEntities(text).replace(/\s+/g, ' '));
}

/** Parse un fragment — ce que fait `innerHTML = …`, texte de premier niveau compris. */
function parseNodes(html: string): ReadonlyArray<string | FakeElement> {
  return parseInto(html).fragment.childNodes;
}

/** Trouve le `>` fermant en respectant les valeurs entre guillemets. */
function findTagEnd(html: string, open: number): number {
  let quote = '';
  for (let i = open + 1; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return html.length;
}

const ATTRIBUTE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const body = raw.replace(/^\/?[a-zA-Z][\w-]*/, '');
  ATTRIBUTE.lastIndex = 0;
  let match = ATTRIBUTE.exec(body);
  while (match) {
    attributes.set(match[1] as string, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
    match = ATTRIBUTE.exec(body);
  }
  return attributes;
}

// --- Le faux Homey ---------------------------------------------------------

/** Ce qu'un handler `onPair` rend, du point de vue de la vue. */
export type Handler = (data: unknown) => unknown;

export interface FakeHomeyOptions {
  /**
   * Les deux chemins de démarrage, et le troisième qui n'aurait pas dû exister.
   *
   * 🔴 `sync` — `Homey.ready()` ne rend rien parce que l'API est DÉJÀ prête — est le
   * chemin sous lequel le bug de course de vtherm se manifestait, et lui seul.
   */
  ready?: 'sync' | 'async' | 'throws';
  handlers?: Record<string, Handler>;
  translations?: Record<string, string>;
  /** Ce que `createDevice` fait — par défaut, il réussit. */
  createDevice?: (payload: Record<string, unknown>) => unknown;
}

/** Le `Homey` que Homey injecte dans une vue de pairing, réduit à ce qui est utilisé. */
export class FakeHomey {
  /** Chaque `emit`, dans l'ordre — c'est la trace qui prouve « lancer puis interroger ». */
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  /**
   * Chaque appel à l'API, méthode par méthode et dans l'ordre.
   *
   * 🔴 C'est ce qui permet de vérifier que `ready()` vient AVANT tout le reste. L'ordre
   * du texte ne prouve rien : `report()` est défini tout en haut du script et contient
   * un `Homey.emit`, mais il n'est appelé qu'après. Seul l'ordre d'exécution compte.
   */
  readonly calls: string[] = [];
  /** Les lignes envoyées à `viewLog`, sans le préfixe de vue. */
  readonly logs: string[] = [];
  /** Chaque charge utile passée à `createDevice`, telle quelle. */
  readonly created: Array<Record<string, unknown>> = [];
  doneCalls = 0;
  readyCalls = 0;
  /**
   * Ce qui a été dit avant que la session écoute.
   *
   * 🔴 C'est tout l'objet de la panne n°8. Une vue qui appelle l'API avant que
   * `ready()` ait rendu la main parle dans le vide : rien n'arrive au driver, et rien
   * ne le signale. Sans ce compteur, un amorçage prématuré passerait ce fichier au
   * vert — le faux `Homey` répondrait à des appels qu'un vrai aurait avalés.
   */
  readonly lostEmits: string[] = [];

  private readonly options: FakeHomeyOptions;
  private live: boolean;

  constructor(options: FakeHomeyOptions = {}) {
    this.options = options;
    // `sync` = l'API est DÉJÀ prête, donc tout est entendu dès la première ligne.
    // C'est le chemin sous lequel le bug de course de vtherm se manifestait, et le
    // seul où l'amorçage immédiat est légitime.
    this.live = options.ready !== 'async';
  }

  ready(): Promise<void> | undefined {
    this.calls.push('ready');
    this.readyCalls += 1;
    if (this.options.ready === 'throws') throw new Error('ready() is not available here');
    if (this.options.ready === 'async') {
      return new Promise((resolve) => {
        setTimeout(() => { this.live = true; resolve(); }, 0);
      });
    }
    return undefined;
  }

  emit(event: string, data: unknown): unknown {
    this.calls.push(`emit:${event}`);
    if (!this.live) {
      this.lostEmits.push(event);
      return Promise.reject(new Error(`"${event}" was emitted before the session was ready`));
    }
    this.emitted.push({ event, data });
    if (event === 'viewLog') {
      this.logs.push(String(data));
      return undefined;
    }
    // Un handler absent est une erreur de montage du test, pas un cas à couvrir :
    // il faut qu'elle soit bruyante, sinon la vue l'avale dans son `catch`.
    const handler = this.options.handlers?.[event];
    if (!handler) throw new Error(`no handler registered for "${event}"`);
    // Un vrai `Homey.emit` rend toujours une promesse. Un handler qui lève doit donc
    // arriver à la vue en rejet, jamais en exception synchrone — sinon on testerait
    // un chemin qui n'existe pas en production.
    try {
      return Promise.resolve(handler(data));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  createDevice(payload: Record<string, unknown>): unknown {
    this.calls.push('createDevice');
    if (!this.live) {
      this.lostEmits.push('createDevice');
      return Promise.reject(new Error('createDevice was called before the session was ready'));
    }
    this.created.push(payload);
    return this.options.createDevice ? this.options.createDevice(payload) : undefined;
  }

  done(): void {
    this.calls.push('done');
    this.doneCalls += 1;
  }

  __(key: string, tags?: Record<string, unknown>): string {
    const value = this.options.translations?.[key];
    if (value === undefined) return key;
    if (!tags) return value;
    return value.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      (name in tags ? String(tags[name]) : match));
  }

  /** Les événements émis, `viewLog` mis à part. */
  events(): string[] {
    return this.emitted.filter((entry) => entry.event !== 'viewLog').map((entry) => entry.event);
  }

  /** Le journal concaténé — pratique pour « la vue a-t-elle dit qu'elle tournait ». */
  log(): string {
    return this.logs.join('\n');
  }
}

// --- La scène --------------------------------------------------------------

/**
 * Un document et une portée globale, partagés — comme Homey le fait pour toutes les
 * vues d'un même driver. Monter deux vues sur la même scène, c'est reproduire
 * exactement la condition de la panne n°7.
 */
export class Stage {
  readonly document = new FakeDocument();
  readonly window = new FakeWindow();
  readonly homey: FakeHomey;
  readonly context: Record<string, unknown>;

  constructor(homey: FakeHomey) {
    this.homey = homey;
    this.context = {
      Homey: homey,
      document: this.document,
      window: this.window,
      console,
      // Les vues attendent 1,5 s entre deux interrogations. Le test n'a aucune raison
      // de les vivre : le délai est ramené à zéro, l'ordonnancement reste réel.
      setTimeout: (callback: () => void) => setTimeout(callback, 0),
      clearTimeout,
    };
    vm.createContext(this.context);
  }

  /**
   * Analyse une vue, accroche ses éléments au document commun, et exécute ses scripts.
   *
   * 🔴 L'analyse est refaite pour CHAQUE scène. Partager un arbre déjà analysé entre
   * deux tests partagerait aussi les valeurs saisies et les écouteurs de clic : un
   * bouton finirait par déclencher le handler d'un test précédent, sur un `Homey` qui
   * n'existe plus. Le symptôme est déroutant — c'est exactement la classe de panne que
   * ce fichier existe pour attraper, et il n'y était pas à l'abri lui-même.
   */
  load(html: string, filename = 'view.js'): ParsedView {
    const view = parseView(html);
    for (const node of view.nodes) this.document.body.appendChild(node);
    for (const script of view.scripts) {
      vm.runInContext(script, this.context, { filename });
    }
    return view;
  }

  /**
   * Ce que les scripts ont laissé traîner dans la portée globale.
   *
   * Doit rester vide : une vue enfermée dans son IIFE ne publie rien, donc rien ne
   * peut écraser la fonction homonyme de la vue voisine.
   */
  globalLeaks(): string[] {
    const injected = new Set(['Homey', 'document', 'window', 'console', 'setTimeout', 'clearTimeout']);
    return Object.keys(this.context).filter((key) => !injected.has(key));
  }

  el(id: string): FakeElement {
    const element = this.document.getElementById(id);
    if (!element) throw new Error(`no element with id "${id}"`);
    return element;
  }
}

/**
 * Laisse les chaînes de promesses des vues se dérouler.
 *
 * Les vues enchaînent `emit` → `then` → `setTimeout` → `emit` ; il faut rendre la main
 * à la boucle d'événements bien plus d'une fois. Cinquante tours à zéro milliseconde
 * coûtent quelques millisecondes et suffisent très largement.
 */
export async function settle(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

// --- Lecture statique ------------------------------------------------------

/**
 * Retire les commentaires d'un script, pour que les garde-fous statiques portent sur
 * du code et pas sur ce qu'on en dit.
 *
 * Les vues expliquent longuement pourquoi elles n'incluent PAS `/homey.js` et
 * n'attendent PAS `onHomeyReady` : sans ce passage, le test qui cherche ces motifs
 * échouerait précisément sur les commentaires qui documentent leur absence.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Ramène une valeur née dans le contexte `vm` vers le réalisme du test.
 *
 * Un objet construit par le script d'une vue tient son prototype du contexte, pas du
 * nôtre : `assert.deepEqual` le refuse avec « same structure but not reference-equal ».
 * Ce passage par JSON efface la différence sans rien changer au contenu.
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
